from pathlib import Path

import pytest
from firedrill import DrillAssertionError, RunResult
from firedrill.models import options, record


def test_options_translate_envelopes_but_never_rewrite_user_data():
    value = options(
        root=Path("project"),
        report_directory="reports",
        seed="42",
        capture={"driver_timeout_ms": 1000},
        setup={"data": [{"value": {"my_field": 4, "myField": 5}}]},
        host_environment={"MY_KEY": "value"},
    )
    assert value["reportDirectory"] == "reports"
    assert value["capture"] == {"driverTimeoutMs": 1000}
    assert value["setup"]["data"][0]["value"] == {"my_field": 4, "myField": 5}
    assert value["hostEnvironment"] == {"MY_KEY": "value"}
    assert value["root"] == "project"
    assert options({"actor_id": "selected"}, actor_id=None) == {"actorId": "selected"}


def test_record_preserves_keys_and_nested_types():
    value = record({"buildHash": "sha256:abc", "value": {"my_field": 4, "myField": 5}})
    assert value.build_hash == "sha256:abc"
    assert value.value["my_field"] == 4
    assert value.value["myField"] == 5
    assert value.to_dict() == dict(value)
    with pytest.raises(AttributeError):
        _ = value.nonexistent


@pytest.mark.parametrize("option_name", ["callback_receivers", "callbackReceivers"])
def test_callback_receiver_options_only_translate_receiver_envelope(option_name):
    source = {
        "my_receiver": {
            "base_url": "http://127.0.0.1:8101",
            "secret": "local-test-value",
            "unknown_field": {"base_url": "keep authored fields", "data_key": 4},
        },
        "another_receiver": {"baseUrl": "http://127.0.0.1:8102"},
    }
    result = options({option_name: source})["callbackReceivers"]
    assert set(result) == {"my_receiver", "another_receiver"}
    assert result["my_receiver"] == {
        "baseUrl": "http://127.0.0.1:8101",
        "secret": "local-test-value",
        "unknown_field": {"base_url": "keep authored fields", "data_key": 4},
    }
    assert result["another_receiver"] == {"baseUrl": "http://127.0.0.1:8102"}
    assert "base_url" in source["my_receiver"]
    assert options(result={"callback_receivers": source})["result"] == {
        "callback_receivers": source
    }


def test_duplicate_callback_receiver_alias_is_rejected():
    with pytest.raises(TypeError, match="Duplicate.*my_receiver.baseUrl"):
        options(callback_receivers={"my_receiver": {"base_url": "a", "baseUrl": "b"}})


def test_failure_assertion_retains_evidence_pointer():
    result = RunResult(
        verdict="failed",
        reportIndex="/project/.firedrill/reports/index.html",
        drills=[{"drillId": "smoke", "verdict": "failed"}],
    )
    with pytest.raises(DrillAssertionError, match="smoke: failed") as caught:
        result.assert_passed()
    assert caught.value.result is result
    assert "index.html" in str(caught.value)
    assert RunResult(verdict="passed").assert_passed().verdict == "passed"
