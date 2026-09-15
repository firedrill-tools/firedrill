import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "./primitives";
import "./scroll-area.css";

interface SectionLink {
  readonly id: string;
  readonly label: string;
}

/** One scroll owner, with discoverable overflow and optional shortcuts to its sections. */
export function ScrollArea({
  label,
  children,
  sections = [],
  resetKey,
  className = "",
  contentClassName = "",
  natural = false,
}: {
  readonly label: string;
  readonly children: ReactNode;
  readonly sections?: readonly SectionLink[];
  readonly resetKey?: string;
  readonly className?: string;
  readonly contentClassName?: string;
  readonly natural?: boolean;
}) {
  const id = useId();
  const viewport = useRef<HTMLElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState({ x: false, y: false, right: false, below: false });

  useEffect(() => {
    const element = viewport.current;
    const body = content.current;
    if (element === null || body === null) return;
    const update = () => {
      const x = element.scrollWidth > element.clientWidth + 2;
      const y = element.scrollHeight > element.clientHeight + 2;
      const next = {
        x,
        y,
        right: x && element.scrollLeft + element.clientWidth < element.scrollWidth - 2,
        below: y && element.scrollTop + element.clientHeight < element.scrollHeight - 2,
      };
      setOverflow((previous) =>
        Object.keys(next).every(
          (key) => previous[key as keyof typeof next] === next[key as keyof typeof next],
        )
          ? previous
          : next,
      );
    };
    const observer = new ResizeObserver(update);
    const mutations = new MutationObserver(update);
    observer.observe(element);
    observer.observe(body);
    mutations.observe(body, { childList: true, subtree: true, characterData: true });
    element.addEventListener("scroll", update, { passive: true });
    update();
    return () => {
      observer.disconnect();
      mutations.disconnect();
      element.removeEventListener("scroll", update);
    };
  }, []);

  useEffect(() => {
    if (resetKey !== undefined) viewport.current?.scrollTo({ top: 0, left: 0 });
  }, [resetKey]);

  const jumpTo = (section: SectionLink) => {
    const element = viewport.current;
    if (element === null) return;
    const target = [...element.querySelectorAll<HTMLElement>("[data-scroll-section]")].find(
      (item) => item.dataset.scrollSection === section.id,
    );
    if (target === undefined) return;
    if (element.scrollHeight > element.clientHeight + 2) {
      element.scrollTo({
        top: element.scrollTop + target.getBoundingClientRect().top - element.getBoundingClientRect().top,
      });
    } else target.scrollIntoView({ block: "start" });
    const heading = target.querySelector<HTMLElement>("h3, summary");
    if (heading !== null) {
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
    }
  };

  return (
    <div className={`fd-scroll-area ${natural ? "fd-scroll-area--natural" : ""} ${className}`.trim()}>
      {sections.length < 2 ? null : (
        <nav className="fd-section-shortcuts" aria-label={`${label} sections`}>
          <span>Jump to</span>
          {sections.map((section) => (
            <Button key={section.id} variant="link" size="compact" onClick={() => jumpTo(section)}>
              {section.label}
            </Button>
          ))}
        </nav>
      )}
      {overflow.x ? (
        <div className="fd-scroll-area__navigation fd-scroll-area__navigation--horizontal">
          <Button
            size="compact"
            aria-controls={id}
            onClick={() => {
              const element = viewport.current;
              if (element !== null)
                element.scrollTo({
                  left: overflow.right ? element.scrollLeft + element.clientWidth * 0.8 : 0,
                });
            }}
          >
            {overflow.right ? (
              <>
                More columns <ArrowRight size={14} aria-hidden="true" />
              </>
            ) : (
              <>
                <ArrowLeft size={14} aria-hidden="true" /> First columns
              </>
            )}
          </Button>
        </div>
      ) : null}
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: The named scroll region must support keyboard scrolling, including tables without interactive cells. */}
      <section ref={viewport} id={id} className="fd-scroll-area__viewport" aria-label={label} tabIndex={0}>
        <div ref={content} className={`fd-scroll-area__content ${contentClassName}`.trim()}>
          {children}
        </div>
      </section>
      {overflow.y ? (
        <div className="fd-scroll-area__navigation">
          <Button
            size="compact"
            aria-controls={id}
            onClick={() => {
              const element = viewport.current;
              if (element !== null)
                element.scrollTo({
                  top: overflow.below ? element.scrollTop + element.clientHeight * 0.8 : 0,
                });
            }}
          >
            {overflow.below ? (
              <>
                More below <ArrowDown size={14} aria-hidden="true" />
              </>
            ) : (
              <>
                Back to top <ArrowUp size={14} aria-hidden="true" />
              </>
            )}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
