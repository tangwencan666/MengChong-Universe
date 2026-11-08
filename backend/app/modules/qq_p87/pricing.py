"""Configurable fictional prices; none of these amounts is a supplier invoice."""

from dataclasses import dataclass
from decimal import ROUND_CEILING, Decimal

from .contracts import Rejected, Usage


@dataclass(frozen=True)
class ExamplePricing:
    # USD / million tokens, deliberately fictional, not DeepSeek's current tariff.
    input_usd: Decimal = Decimal("1.00")
    cached_usd: Decimal = Decimal("0.10")
    output_usd: Decimal = Decimal("2.00")
    version: str = "p87-FICTIONAL-USD-per-million-v1"

    def cost_micro_usd(self, usage: Usage) -> int:
        values = (usage.input_tokens, usage.output_tokens, usage.cache_hit_tokens)
        prices = (self.input_usd, self.cached_usd, self.output_usd)
        if (
            any(type(v) is not int or not 0 <= v <= 1_000_000 for v in values)
            or usage.cache_hit_tokens > usage.input_tokens
            or any(not p.is_finite() or p < 0 or p > 1000 for p in prices)
            or self.cached_usd > self.input_usd
        ):
            raise Rejected("INVALID_SIMULATED_USAGE")
        # USD/million multiplied by token counts is already micro-USD.
        value = (
            (usage.input_tokens - usage.cache_hit_tokens) * self.input_usd
            + usage.cache_hit_tokens * self.cached_usd
            + usage.output_tokens * self.output_usd
        )
        return int(value.to_integral_value(rounding=ROUND_CEILING))


@dataclass(frozen=True)
class Limits:
    input_tokens: int = 8000
    output_tokens: int = 800
    account_daily_messages: int = 50
    protected_daily_messages: int = 5
    account_daily_micro_usd: int = 1_000_000
    bot_daily_micro_usd: int = 10_000_000
    global_daily_micro_usd: int = 20_000_000
    account_per_minute: int = 6
    bot_per_minute: int = 60
    global_per_minute: int = 120
    pending: int = 32
    concurrent_models: int = 2
    model_timeout_seconds: float = 2
    send_timeout_seconds: float = 1
    queue_timeout_seconds: float = 2
    reply_age_seconds: int = 120

    def __post_init__(self):
        integers = (
            self.input_tokens,
            self.output_tokens,
            self.account_daily_messages,
            self.protected_daily_messages,
            self.account_daily_micro_usd,
            self.bot_daily_micro_usd,
            self.global_daily_micro_usd,
            self.account_per_minute,
            self.bot_per_minute,
            self.global_per_minute,
            self.pending,
            self.concurrent_models,
            self.reply_age_seconds,
        )
        if (
            any(type(v) is not int or not 1 <= v <= 1_000_000_000 for v in integers)
            or not 1 <= self.concurrent_models <= self.pending <= 256
            or self.input_tokens > 8000
            or self.output_tokens > 800
            or self.protected_daily_messages > self.account_daily_messages
            or self.reply_age_seconds > 120
            or any(
                not 0 < v <= 30
                for v in (
                    self.model_timeout_seconds,
                    self.send_timeout_seconds,
                    self.queue_timeout_seconds,
                )
            )
        ):
            raise Rejected("INVALID_LAB_LIMITS")
