"""Deterministic Mock safety baseline, not a production semantic moderation service."""

import re
import unicodedata

from .contracts import Rejected


def plain(value: str, limit: int) -> str:
    if not isinstance(value, str) or not value.strip() or len(value.encode("utf-8")) > limit:
        raise Rejected("TEXT_LIMIT")
    text = unicodedata.normalize("NFKC", value)
    text = "".join(c for c in text if unicodedata.category(c) != "Cf")
    text = text.replace("。", ".").replace("·", ".")
    if any(ord(c) < 32 and c not in "\n\t" for c in text):
        raise Rejected("TEXT_CONTROL")
    return text


def screen_input(value: str) -> str:
    value = plain(value, 3000)
    if re.search(
        r"忽略.{0,30}(?:规则|指令)|(?:读取|泄露).{0,30}(?:别人|其他宠物)|系统提示词|"
        r"ignore.{0,40}(?:instructions|previous)|system\s*prompt|dump.{0,20}memory|"
        r"验证码|转账|收款码|密码|诈骗|钓鱼|批量群发|/exec|powershell|cmd\.exe",
        value,
        re.IGNORECASE,
    ):
        raise Rejected("INPUT_BLOCKED")
    return value


def screen_output(value: str, *, protected: bool) -> str:
    value = plain(value, 2400)
    risk = (
        r"https?\s*:|www\s*\.|[a-z0-9-]+\s*(?:\.|\[\.\])\s*"
        r"(?:com|net|org|cn|xyz|top|io)\b|验证码|转账|收款|密码|充值|付款|支付|"
        r"人工客服|腾讯客服|我是.{0,8}(?:真人|人类)|官方客服|"
        r"@(?:all|everyone|here)|<@|/exec|powershell|cmd\.exe|"
        r'"(?:recipient|tool_calls|target|command)"\s*:'
    )
    if re.search(risk, value, re.IGNORECASE) or (
        protected
        and re.search(r"成人|色情|只能爱我|只爱我|离不开我|付费.{0,6}才|秘密不要告诉", value)
    ):
        raise Rejected("OUTPUT_BLOCKED")
    return value
