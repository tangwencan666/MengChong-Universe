"""Reproducible offline arithmetic, not a load test or a provider price quote."""

from decimal import ROUND_CEILING, Decimal, InvalidOperation

from .contracts import Rejected, Usage
from .pricing import ExamplePricing


def ceiling(value: Decimal) -> int:
    return int(value.to_integral_value(rounding=ROUND_CEILING))


def forecast(config: dict) -> dict:
    decimal_fields = (
        "input_usd_per_million",
        "cached_usd_per_million",
        "output_usd_per_million",
        "service_seconds",
        "peak_factor",
        "target_utilization",
        "mode_b_socket_mib",
    )
    integer_fields = (
        "input_tokens",
        "output_tokens",
        "cache_hit_tokens",
        "max_input_tokens",
        "max_output_tokens",
        "active_hours",
        "model_retries",
        "metadata_row_bytes",
        "metadata_index_multiplier",
        "retention_days",
        "dedupe_entry_bytes",
        "mode_a_bot_count",
    )
    if not isinstance(config, dict) or set(config) != {
        "kind",
        "currency",
        *decimal_fields,
        *integer_fields,
    }:
        raise Rejected("INVALID_CAPACITY_CONFIG")
    if config.get("kind") != "FICTIONAL_P87_EXAMPLE_NOT_A_QUOTE" or config.get("currency") != "USD":
        raise Rejected("EXAMPLE_CONFIG_REQUIRED")
    if any(
        type(config.get(k)) is not int or not 0 <= config[k] <= 1_000_000 for k in integer_fields
    ):
        raise Rejected("INVALID_CAPACITY_CONFIG")
    try:
        decimals = [Decimal(str(config[k])) for k in decimal_fields]
    except (InvalidOperation, ValueError):
        raise Rejected("INVALID_CAPACITY_CONFIG") from None
    price = ExamplePricing(*decimals[:3])
    typical = price.cost_micro_usd(
        Usage(config["input_tokens"], config["output_tokens"], config["cache_hit_tokens"])
    )
    worst = price.cost_micro_usd(Usage(config["max_input_tokens"], config["max_output_tokens"]))
    service, peak, utilization, socket = decimals[3:]
    if (
        any(not v.is_finite() for v in (service, peak, utilization, socket))
        or not 0 < service <= 120
        or not 1 <= peak <= 100
        or not 0 < utilization < 1
        or not 0 <= socket <= 10
        or not 1 <= config["active_hours"] <= 24
        or config["model_retries"] not in {0, 1}
        or config["input_tokens"] > config["max_input_tokens"]
        or config["output_tokens"] > config["max_output_tokens"]
        or config["metadata_row_bytes"] < 1
        or config["metadata_index_multiplier"] < 1
        or config["dedupe_entry_bytes"] < 1
        or not 1 <= config["retention_days"] <= 30
        or not 1 <= config["mode_a_bot_count"] <= 10
    ):
        raise Rejected("INVALID_CAPACITY_CONFIG")
    rows = []
    for users in (100, 500, 1000):
        for messages in (10, 20, 50):
            daily = users * messages
            avg = Decimal(daily) / (config["active_hours"] * 3600)
            rps = avg * peak
            concurrency = ceiling(rps * service / utilization)
            burst = ceiling(rps * 10)
            max_burst_wait = max(0, ceiling(Decimal(burst) / concurrency) - 1) * service
            pg = daily * config["metadata_row_bytes"] * config["metadata_index_multiplier"]
            rows.append(
                {
                    "registered_and_daily_active_users": users,
                    "messages_per_user_day": messages,
                    "messages_per_day": daily,
                    "input_tokens_per_day": daily * config["input_tokens"],
                    "output_tokens_per_day": daily * config["output_tokens"],
                    "cache_hit_tokens_per_day": daily * config["cache_hit_tokens"],
                    "simulated_daily_model_usd": str(Decimal(typical * daily) / 1_000_000),
                    "simulated_30day_model_usd": str(Decimal(typical * daily * 30) / 1_000_000),
                    "reserved_daily_upper_usd": str(Decimal(worst * daily) / 1_000_000),
                    "hypothetical_retry_upper_usd": str(
                        Decimal(worst * daily * (1 + config["model_retries"])) / 1_000_000
                    ),
                    "active_average_rps": str(round(avg, 4)),
                    "peak_rps_assumed": str(round(rps, 4)),
                    "model_concurrency_planned": concurrency,
                    "isolated_10second_burst_last_job_wait_seconds": str(max_burst_wait),
                    "postgres_metadata_mib_per_day": str(round(Decimal(pg) / 1048576, 2)),
                    "postgres_metadata_gib_retained": str(
                        round(Decimal(pg * config["retention_days"]) / 1073741824, 3)
                    ),
                    "redis_dedupe_mib_one_day": str(
                        round(Decimal(daily * config["dedupe_entry_bytes"]) / 1048576, 2)
                    ),
                    "mode_a_connections_assumed": config["mode_a_bot_count"],
                    "mode_b_connections_assumed": users,
                    "mode_b_socket_memory_mib_assumed": str(socket * users),
                    "actual_supplier_cost_usd": None,
                    "measured_capacity": False,
                }
            )
    return {"kind": config["kind"], "config": config, "scenarios": rows, "live_requests": 0}
