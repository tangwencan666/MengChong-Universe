import json
from decimal import Decimal
from pathlib import Path

import pytest

from app.modules.qq_p87.capacity import forecast
from app.modules.qq_p87.contracts import Rejected

CONFIG = json.loads(
    (Path(__file__).parents[1] / "app/modules/qq_p87/capacity_example.json").read_text(
        encoding="utf-8"
    )
)


def test_all_nine_scenarios_have_consistent_units_and_no_invoice_or_measured_claim():
    report = forecast(CONFIG)
    assert len(report["scenarios"]) == 9 and report["live_requests"] == 0
    low, high = report["scenarios"][0], report["scenarios"][-1]
    assert low["messages_per_day"] == 1000 and low["simulated_daily_model_usd"] == "2.15"
    assert high["messages_per_day"] == 50000 and high["simulated_daily_model_usd"] == "107.5"
    assert high["simulated_30day_model_usd"] == "3225"
    assert high["reserved_daily_upper_usd"] == "480"
    assert high["model_concurrency_planned"] == 125
    assert all(
        row["actual_supplier_cost_usd"] is None and not row["measured_capacity"]
        for row in report["scenarios"]
    )


def test_cache_is_only_a_configured_assumption_and_optional_retry_is_a_cost_sensitivity():
    no_cache = forecast(CONFIG | {"cache_hit_tokens": 0})["scenarios"][0]
    assert no_cache["simulated_daily_model_usd"] == "2.6"
    sensitivity = forecast(CONFIG | {"model_retries": 1})["scenarios"][-1]
    assert Decimal(sensitivity["hypothetical_retry_upper_usd"]) == 960


@pytest.mark.parametrize(
    "changes",
    [
        {"kind": "REAL_INVOICE"},
        {"currency": "CNY"},
        {"model_retries": 2},
        {"input_usd_per_million": "-1"},
        {"target_utilization": "0"},
        {"active_hours": 0},
        {"cache_hit_tokens": 2001},
        {"service_seconds": "NaN"},
        {"service_seconds": "invalid"},
        {"unexpected_credential": "SYNTHETIC"},
        {"dedupe_entry_bytes": 0},
    ],
)
def test_invalid_or_mislabeled_forecast_inputs_fail(changes):
    with pytest.raises(Rejected):
        forecast(CONFIG | changes)
