"""Finite per-launch desktop budget, separate from persistent beta hard quotas.

Single-process local use only. No prompt/credential persistence or automatic refill.
Failures and cancellations after admission still consume a slot.
"""

import json
from threading import Lock

from app.core.errors import AppError


class LocalModelBudgetError(AppError):
    def __init__(self, code):
        messages = {
            "LOCAL_MODEL_BUDGET_EXHAUSTED": "本次本地体验的模型请求额度已用完。",
            "LOCAL_MODEL_INPUT_LIMIT": "当前对话超过本次模型输入上限，请开启新会话或缩短消息。",
            "LOCAL_MODEL_POLICY_CHANGED": "本次模型配置已改变，请停止服务并重新确认。",
        }
        super().__init__(429, code, messages[code])


def policy(settings):
    return (
        settings.local_deepseek_max_requests,
        settings.local_deepseek_max_input_bytes,
        settings.deepseek_max_tokens,
        settings.deepseek_model,
        frozenset((item.owner_id, item.pet_id) for item in settings.local_deepseek_pets),
    )


class LocalDeepSeekBudget:
    def __init__(self, settings):
        self._policy = policy(settings)
        self.limit = settings.local_deepseek_max_requests
        self.used = 0
        self._lock = Lock()

    def admit(self, settings, messages, system_prompt):
        payload = [{"role": "system", "content": system_prompt}, *messages]
        size = len(json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode())
        with self._lock:
            if self._policy != policy(settings) or not self.limit:
                raise LocalModelBudgetError("LOCAL_MODEL_POLICY_CHANGED")
            if size > self._policy[1] or len(messages) > 21:
                raise LocalModelBudgetError("LOCAL_MODEL_INPUT_LIMIT")
            if self.used >= self.limit:
                raise LocalModelBudgetError("LOCAL_MODEL_BUDGET_EXHAUSTED")
            self.used += 1
