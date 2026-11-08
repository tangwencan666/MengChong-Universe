"""Versioned synthetic lexical gold cases; no facts are loaded from a real user."""

from dataclasses import replace
from datetime import UTC, datetime, timedelta
from uuid import UUID

import pytest

from app.modules.memory.retrieval import MemoryCandidate, rank_memories

OWNER = UUID(int=1)
OTHER = UUID(int=2)
AT = datetime(2026, 11, 1, tzinfo=UTC)

# Explicit expected-topic labels are maintained independently of the ranker's implementation.
CAREER_GOLD = (
    ("后端开发", "想聊聊服务端岗位的准备"),
    ("前端开发", "前端方面有什么需要准备的"),
    ("数据分析", "我想聊数据分析的目标"),
    ("产品经理", "可以接着聊产品经理方向吗"),
    ("软件测试", "测试开发的准备可以继续聊吗"),
    ("算法工程", "算法岗位的事情想继续聊"),
    ("运维工程", "现在想了解DevOps的目标"),
    ("网络安全", "想聊信息安全方向"),
    ("嵌入式", "嵌入式岗位有什么进展"),
    ("用户研究", "可以聊聊用户调研的事情吗"),
    ("交互设计", "想继续聊交互设计"),
    ("视觉设计", "视觉传达方向的事情"),
    ("游戏开发", "想继续考虑游戏程序岗位"),
    ("移动开发", "Android方向可以接着聊吗"),
    ("数据工程", "想聊数据管道方向的目标"),
    ("机器学习", "想接着谈machine learning的目标"),
    ("Java开发", "想聊JAVA方向的准备"),
    ("Python开发", "Python方向有什么进展"),
    ("Go开发", "可以接着聊GO吗"),
    ("技术写作", "想了解技术文档岗位"),
)
EXPERIENCE_GOLD = (
    ("实习经历", "想聊聊那段实习经验"),
    ("校园活动", "可以继续聊社团活动吗"),
    ("项目协作", "我想复盘团队协作"),
    ("演讲比赛", "想聊演讲竞赛的事"),
    ("志愿服务", "继续说说志愿活动"),
    ("团队领导", "想接着聊带领团队的经历"),
    ("毕业设计", "毕业论文的事情可以继续吗"),
    ("开源贡献", "接着说开源项目吧"),
    ("课程助教", "想聊担任助教的事"),
    ("竞赛经历", "可以聊那段比赛经历吗"),
)
OPEN_GOLD = (
    ("简历修改", "想继续修改简历"),
    ("面试复盘", "可以复盘面试吗"),
    ("笔试准备", "想继续准备笔试"),
    ("投递进展", "简历投递结果想继续聊"),
    ("薪资沟通", "关于薪资协商的事"),
    ("offer选择", "想继续选择offer"),
    ("入职准备", "可以接着准备入职吗"),
    ("职业规划", "想接着规划职业"),
    ("作品集", "继续聊portfolio"),
    ("时间安排", "我想继续日程安排"),
)
NEGATIVE_GOLD = (
    "今天的烤面包很好吃",
    "想说说窗边的绿植",
    "湖边的风景很美",
    "周末听到一首歌",
    "橘猫趴在沙发上",
    "杯子里的茶有点凉",
    "阳光照进房间",
    "想挑选一部电影",
    "雨后看到了彩虹",
    "早上发现一朵小花",
)
PREFERENCE_GOLD = (
    "简短回应",
    "分点说明",
    "耐心解释",
    "自然语气",
    "先听再说",
    "减少术语",
    "举例说明",
    "不要催促",
    "平等交流",
    "给我时间",
)


def candidate(number=10, *, topic="后端开发", category="career_goal", owner=OWNER):
    return MemoryCandidate(
        id=UUID(int=number),
        owner_id=owner,
        version=1,
        title=topic,
        content=f"我选择保留的{topic}事项。",
        category=category,
        confirmed_at=AT,
        grant_id=UUID(int=1000 + number),
        source_refs=({"kind": "manual", "session_id": None, "message_id": None},),
        expires_at=AT + timedelta(days=180),
    )


def topic_corpus():
    return [
        candidate(index + 10, topic=topic, category=category)
        for index, (category, topic) in enumerate(
            [("career_goal", topic) for topic, _ in CAREER_GOLD]
            + [("experience", topic) for topic, _ in EXPERIENCE_GOLD]
            + [("open_topic", topic) for topic, _ in OPEN_GOLD]
        )
    ]


@pytest.mark.parametrize("topic,query", CAREER_GOLD + EXPERIENCE_GOLD + OPEN_GOLD)
def test_lexical_gold_expected_topic_is_retrieved(topic, query):
    hits = rank_memories(query, topic_corpus(), OWNER, include_preference=False, at=AT)
    assert hits and hits[0].candidate.title == topic
    assert {hit.candidate.title for hit in hits} == {topic}
    assert all(hit.matched_terms and hit.score > 0 for hit in hits)


@pytest.mark.parametrize("query", NEGATIVE_GOLD)
def test_unrelated_gold_queries_return_no_topic_memory(query):
    assert rank_memories(query, topic_corpus(), OWNER, include_preference=False, at=AT) == []


@pytest.mark.parametrize("preference", PREFERENCE_GOLD)
def test_explicit_communication_preference_is_one_separate_fallback(preference):
    selected = candidate(900, topic=preference, category="communication_preference")
    older = replace(selected, id=UUID(int=901), confirmed_at=AT - timedelta(days=1))
    hits = rank_memories("今天的花很好看", [selected, older], OWNER, at=AT)
    assert len(hits) == 1 and hits[0].candidate.id == selected.id
    assert rank_memories("今天的花很好看", [selected], OWNER, include_preference=False, at=AT) == []


def test_versioned_gold_metrics_are_reported_separately_from_preference_fallback():
    precisions, recalls = [], []
    for topic, query in CAREER_GOLD + EXPERIENCE_GOLD + OPEN_GOLD:
        hits = rank_memories(query, topic_corpus(), OWNER, include_preference=False, at=AT)
        found = [hit for hit in hits if hit.candidate.title == topic]
        precisions.append(len(found) / len(hits) if hits else 0)
        recalls.append(min(1, len(found)))
    assert len(precisions) == 40 and len(NEGATIVE_GOLD) == 10 and len(PREFERENCE_GOLD) == 10
    assert sum(precisions) / len(precisions) >= 0.90
    assert sum(recalls) / len(recalls) >= 0.85


def test_owner_expiry_and_missing_grant_are_defensive_filters():
    own = candidate()
    forbidden = [
        replace(own, id=UUID(int=11), owner_id=OTHER),
        replace(own, id=UUID(int=12), expires_at=AT),
        replace(own, id=UUID(int=13), grant_id=None),
        replace(own, id=UUID(int=14), version=0),
    ]
    hits = rank_memories("后端", [own, *forbidden], OWNER, at=AT)
    assert [hit.candidate.id for hit in hits] == [own.id]


def test_ranking_has_stable_confirmation_and_id_tiebreakers():
    first, second = candidate(10), candidate(11)
    recent = replace(candidate(12), confirmed_at=AT + timedelta(hours=1))
    hits = rank_memories("后端", [second, recent, first], OWNER, at=AT)
    assert [hit.candidate.id for hit in hits] == [recent.id, first.id, second.id]


def test_matching_normalization_does_not_rewrite_original_facts():
    fact = candidate(topic="Ｐｙｔｈｏｎ开发")
    hits = rank_memories("python", [fact], OWNER, at=AT)
    assert hits[0].candidate.content == fact.content
    assert "Ｐｙｔｈｏｎ" in hits[0].candidate.content
    unknown_phrase = candidate(30, topic="低温实验", category="explicit_note")
    assert rank_memories("想聊低温实验的进展", [unknown_phrase], OWNER, at=AT)
    assert rank_memories("我希望了解今天最近的事情", [fact], OWNER, at=AT) == []


def test_generic_shared_language_is_not_enough_for_topic_relevance():
    facts = [replace(candidate(), title="普通记录", content="我希望了解一些最近的事情。")]
    assert rank_memories("我希望了解今天的事情", facts, OWNER, at=AT) == []
    english = replace(
        candidate(), title="My note", content="I would like to talk about my painting."
    )
    assert rank_memories("I would like to discuss my cooking", [english], OWNER, at=AT) == []


def test_capacity_quantity_and_preference_slot_are_bounded():
    facts = [candidate(i) for i in range(10, 210)]
    preference = candidate(900, topic="自然语气", category="communication_preference")
    hits = rank_memories("后端", facts[:5] + [preference], OWNER, limit=5, at=AT)
    assert len(hits) == 5
    assert sum(hit.candidate.category == "communication_preference" for hit in hits) == 1
    assert rank_memories("后端", facts, OWNER, limit=1, at=AT)[0].candidate.id == UUID(int=10)
    with pytest.raises(ValueError, match="capacity"):
        rank_memories("后端", facts + [candidate(999)], OWNER, at=AT)
    for limit in (0, 6, True, 1.5):
        with pytest.raises(ValueError):
            rank_memories("后端", facts[:1], OWNER, limit=limit, at=AT)


def test_short_unknown_synonyms_are_not_misrepresented_as_semantic_search():
    fact = candidate(topic="Go岗位")
    assert rank_memories("Go", [fact], OWNER, at=AT)
    assert rank_memories("golang", [fact], OWNER, at=AT) == []


@pytest.mark.parametrize(
    "query,topic",
    [
        ("My curiosity about the garden", "移动开发"),
        ("We can disregard that detail", "运维工程"),
        ("Exploring bioscience", "移动开发"),
        ("A backendless art project", "后端开发"),
        ("Working with myios_identifier", "移动开发"),
    ],
)
def test_ascii_alias_substrings_do_not_make_unrelated_memories_relevant(query, topic):
    assert rank_memories(query, [candidate(topic=topic)], OWNER, at=AT) == []


@pytest.mark.parametrize(
    "query,topic",
    [
        ("想聊iOS岗位", "移动开发"),
        ("iOS开发方向", "移动开发"),
        ("想聊SRE岗位", "运维工程"),
        ("SRE方向的准备", "运维工程"),
        ("想聊back-end岗位", "后端开发"),
        ("I am interested in data analysis", "数据分析"),
        ("可以继续聊product manager方向吗", "产品经理"),
    ],
)
def test_complete_ascii_aliases_preserve_chinese_adjacency_and_phrases(query, topic):
    hits = rank_memories(query, [candidate(topic=topic)], OWNER, at=AT)
    assert [hit.candidate.title for hit in hits] == [topic]


def test_private_candidate_and_hit_repr_do_not_contain_memory_body():
    fact = replace(candidate(), content="synthetic-private-body-not-for-logs")
    hit = rank_memories("后端", [fact], OWNER, at=AT)[0]
    assert fact.content not in repr(fact) and fact.content not in repr(hit)
