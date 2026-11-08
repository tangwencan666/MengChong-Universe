"""Bounded, deterministic lexical ranking of already-authorized memory candidates.

This module does not query a database or establish consent. The repository must
validate the current grant and all sources before constructing candidates.
"""

import re
import unicodedata
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import UTC, datetime
from itertools import islice
from uuid import UUID

RETRIEVER_VERSION = "local-lexical/1"
MAX_CANDIDATES = 200

# These are lexical aliases, not inferred personal facts or semantic embeddings.
DOMAIN_ALIASES = {
    "后端": ("后端", "服务端", "backend", "back-end"),
    "前端": ("前端", "frontend", "front-end"),
    "数据分析": ("数据分析", "data analyst", "data analysis"),
    "产品经理": ("产品经理", "product manager"),
    "软件测试": ("软件测试", "测试开发", "software testing"),
    "算法工程": ("算法工程", "算法岗位"),
    "运维": ("运维", "devops", "sre"),
    "网络安全": ("网络安全", "信息安全", "cybersecurity"),
    "嵌入式": ("嵌入式", "embedded"),
    "用户研究": ("用户研究", "用户调研"),
    "交互设计": ("交互设计", "交互体验"),
    "视觉设计": ("视觉设计", "视觉传达"),
    "游戏开发": ("游戏开发", "游戏程序"),
    "移动开发": ("移动开发", "手机应用", "android", "ios"),
    "数据工程": ("数据工程", "数据管道"),
    "机器学习": ("机器学习", "machine learning"),
    "技术写作": ("技术写作", "技术文档"),
    "实习经历": ("实习经历", "实习经验"),
    "校园活动": ("校园活动", "社团活动"),
    "项目协作": ("项目协作", "团队协作"),
    "演讲比赛": ("演讲比赛", "演讲竞赛"),
    "志愿服务": ("志愿服务", "志愿活动"),
    "团队领导": ("团队领导", "带领团队"),
    "毕业设计": ("毕业设计", "毕业论文"),
    "开源贡献": ("开源贡献", "开源项目"),
    "课程助教": ("课程助教", "担任助教"),
    "竞赛经历": ("竞赛经历", "比赛经历"),
    "简历修改": ("简历修改", "修改简历", "简历优化"),
    "面试复盘": ("面试复盘", "复盘面试"),
    "笔试准备": ("笔试准备", "准备笔试"),
    "投递进展": ("投递进展", "投递结果", "简历投递"),
    "薪资沟通": ("薪资沟通", "薪资协商"),
    "offer选择": ("offer选择", "选择offer"),
    "入职准备": ("入职准备", "准备入职"),
    "职业规划": ("职业规划", "规划职业"),
    "作品集": ("作品集", "portfolio"),
    "时间安排": ("时间安排", "日程安排"),
}
STOP_WORDS = frozenset(
    {
        "the",
        "and",
        "for",
        "with",
        "about",
        "please",
        "want",
        "would",
        "like",
        "can",
        "how",
        "what",
        "this",
        "that",
        "have",
        "help",
        "some",
        "talk",
        "today",
        "me",
        "my",
        "to",
        "of",
        "in",
        "on",
        "is",
        "an",
        "as",
        "at",
        "it",
        "we",
        "you",
        "your",
        "our",
        "do",
        "am",
        "be",
        "or",
        "not",
        "was",
        "are",
        "been",
        "need",
        "remember",
        "discuss",
        "more",
        "using",
        "希望",
        "今天",
        "最近",
        "可以",
        "了解",
        "事情",
        "聊聊",
        "想要",
        "一下",
        "关于",
        "什么",
        "建议",
        "准备",
        "岗位",
        "工作",
        "开发",
        "方向",
        "同学",
        "计划",
        "经历",
        "自己",
        "我的",
        "你的",
        "我们",
        "之前",
        "时候",
        "怎样",
        "怎么",
        "喜欢",
        "能够",
    }
)
ENGLISH_WORD = re.compile(r"[a-z][a-z0-9_+#.-]{1,39}")
CHINESE_RUN = re.compile(r"[\u3400-\u9fff]+")
CATEGORIES = frozenset(
    {"career_goal", "communication_preference", "experience", "open_topic", "explicit_note"}
)


@dataclass(frozen=True, repr=False)
class MemoryCandidate:
    id: UUID
    owner_id: UUID
    version: int
    title: str
    content: str
    category: str
    confirmed_at: datetime
    grant_id: UUID
    source_refs: tuple[dict[str, str | None], ...]
    expires_at: datetime


@dataclass(frozen=True, repr=False)
class RankedHit:
    candidate: MemoryCandidate
    matched_terms: tuple[str, ...]
    score: int


def _normalize(value: str) -> str:
    return unicodedata.normalize("NFKC", value).casefold()


def _time(value: datetime) -> datetime:
    return value.replace(tzinfo=value.tzinfo or UTC).astimezone(UTC)


def _contains_alias(normalized: str, alias: str) -> bool:
    if alias.isascii():
        # ASCII aliases must name a complete word/phrase, not a substring such
        # as "ios" in "curiosity". Chinese adjacency remains valid ("iOS岗位").
        return (
            re.search(r"(?<![a-z0-9_])" + re.escape(alias) + r"(?![a-z0-9_])", normalized)
            is not None
        )
    return alias in normalized


def _features(value: str) -> tuple[set[str], set[str]]:
    normalized = _normalize(value)
    words = {word.strip(".-") for word in ENGLISH_WORD.findall(normalized)} - STOP_WORDS
    domains = {
        name
        for name, aliases in DOMAIN_ALIASES.items()
        if any(_contains_alias(normalized, alias) for alias in aliases)
    }
    # Remove boilerplate before making overlapping grams, otherwise fragments
    # across "我希望了解" (e.g. 我希/望了) falsely look like specific evidence.
    lexical = normalized
    for word in sorted((word for word in STOP_WORDS if not word.isascii()), key=len, reverse=True):
        lexical = lexical.replace(word, " ")
    lexical = re.sub(r"[我你他她它的了呢吗和与在有想说]", " ", lexical)
    grams = {
        run[index : index + 2]
        for run in CHINESE_RUN.findall(lexical)
        for index in range(len(run) - 1)
    } - STOP_WORDS
    return words | domains, grams


def _match(query: str, candidate: MemoryCandidate) -> RankedHit | None:
    strong, grams = _features(query)
    title_strong, title_grams = _features(candidate.title)
    body_strong, body_grams = _features(candidate.content)
    shared_strong = strong & (title_strong | body_strong)
    shared_grams = grams & (title_grams | body_grams)
    if not shared_strong and len(shared_grams) < 2:
        return None
    score = 200 * len(shared_strong) + 5 * len(shared_grams)
    score += 40 * len(strong & title_strong) + 4 * len(grams & title_grams)
    normalized = _normalize(query).strip()
    if len(normalized) >= 2 and normalized in _normalize(
        candidate.title + "\n" + candidate.content
    ):
        score += 80
    return RankedHit(candidate, tuple(sorted(shared_strong | shared_grams)), score)


def rank_memories(
    query: str,
    candidates: Iterable[MemoryCandidate],
    owner_id: UUID,
    limit: int = 5,
    include_preference: bool = True,
    *,
    at: datetime | None = None,
) -> list[RankedHit]:
    """Rank only current-owner data, with one optional explicit preference fallback.

    Fact text is never normalized or rewritten. Search aliases and Unicode
    normalization affect matching only. No query or memory body is logged.
    """
    if not isinstance(query, str) or not 1 <= len(query.strip()) <= 4000:
        raise ValueError("A bounded nonempty lexical query is required")
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 5:
        raise ValueError("Memory limit must be between one and five")
    rows = list(islice(candidates, MAX_CANDIDATES + 1))
    if len(rows) > MAX_CANDIDATES:
        raise ValueError("The owner candidate capacity was exceeded")
    current = _time(at or datetime.now(UTC))
    topics, preferences = [], []
    for candidate in rows:
        if (
            candidate.owner_id != owner_id
            or _time(candidate.expires_at) <= current
            or not candidate.grant_id
            or candidate.version < 1
            or candidate.category not in CATEGORIES
            or not 1 <= len(candidate.content) <= 1000
        ):
            continue
        matched = _match(query, candidate)
        if candidate.category == "communication_preference":
            if include_preference:
                preferences.append(matched or RankedHit(candidate, (), 0))
        elif matched:
            topics.append(matched)

    def order(hit):
        return (-hit.score, -_time(hit.candidate.confirmed_at).timestamp(), str(hit.candidate.id))

    topics.sort(key=order)
    preferences.sort(key=order)
    selected = topics[:limit]
    if preferences and (len(selected) < limit or limit > 1):
        selected = selected[: max(0, limit - 1)] + preferences[:1]
    return selected
