import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ActorIdentity } from "./actor-identity";

describe("actor identity descriptions", () => {
  it("shows the authored description as plain text below the identity", () => {
    const markup = renderToStaticMarkup(
      <ActorIdentity
        actor={{ id: "operator", description: "Reviews incoming observations.", attributes: {}, grants: [] }}
      />,
    );
    expect(markup).toContain("<code>operator</code>");
    expect(markup).toContain('class="fd-actor-identity__description">Reviews incoming observations.</p>');
  });

  it("renders no empty description or invented fallback for existing actors", () => {
    const markup = renderToStaticMarkup(
      <ActorIdentity actor={{ id: "operator", attributes: {}, grants: [] }} />,
    );
    expect(markup).toContain("<code>operator</code>");
    expect(markup).not.toContain("<p");
    expect(markup).not.toContain("description");
  });

  it("escapes markup rather than interpreting a description as HTML or Markdown", () => {
    const markup = renderToStaticMarkup(
      <ActorIdentity
        actor={{
          id: "operator",
          description: '<script>alert("note")</script> **ordinary text**',
          attributes: {},
          grants: [],
        }}
      />,
    );
    expect(markup).not.toContain("<script>");
    expect(markup).toContain("&lt;script&gt;");
    expect(markup).toContain("**ordinary text**");
  });
});
