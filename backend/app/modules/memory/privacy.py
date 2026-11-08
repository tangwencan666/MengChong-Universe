"""Conservative local screening, not a claim of complete sensitive-data detection."""

import re

from app.core.errors import AppError

PATTERNS = (
    r"-----BEGIN .*PRIVATE KEY-----",
    r"\bsk-[A-Za-z0-9_-]{16,}",
    r"(?i)(password|api[_ -]?key|secret|token|验证码|密码|密钥)\s*(?:[:：=]|是|为)\s*\S+",
    r"\b\d{15,19}[0-9Xx]?\b",
    r"(?i)(银行卡|身份证|社会安全号码|credit card|passport|ssn)",
    r"(?i)(住址|家庭地址|精确地址|home address|street address)",
    r"(?i)(诊断|确诊|病历|diagnosed|diagnosis)",
    r"(?i)(自杀|自残|不想活|结束生命|suicid|self[- ]harm|kill myself)",
    r"(?i)(他人|别人的|第三方).{0,10}(隐私|电话|住址|身份证|密码)",
)


def screen(title: str, content: str) -> None:
    value = title + "\n" + content
    if any(re.search(pattern, value) for pattern in PATTERNS):
        raise AppError(422, "SENSITIVE_MEMORY_REJECTED", "这类敏感信息暂不支持保存为长期记忆。")
