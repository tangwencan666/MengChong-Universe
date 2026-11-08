"""Single-process Mock metadata ledger. No message, reply, memory or secret columns.

Create refuses existing files. Reopen validates this lab's namespace/run/pepper
read-only first. Nothing creates a PostgreSQL engine or reads application config.
"""

import hashlib
import hmac
import json
import secrets
import sqlite3
import threading
from contextlib import closing, contextmanager
from pathlib import Path
from uuid import uuid4

from .contracts import Receipt, Rejected, Scope, uuid
from .pricing import Limits

ACTIVE = ("admitted", "generating", "sending")
SCHEMA = """
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE bots (id TEXT PRIMARY KEY, manager TEXT, enabled INTEGER NOT NULL);
CREATE TABLE accounts (owner TEXT PRIMARY KEY, granted INTEGER NOT NULL,
 reserved INTEGER NOT NULL DEFAULT 0, spent INTEGER NOT NULL DEFAULT 0,
 enabled INTEGER NOT NULL DEFAULT 1, protected INTEGER NOT NULL DEFAULT 1,
 CHECK(reserved>=0 AND spent>=0 AND reserved+spent<=granted));
CREATE TABLE challenges (token_hash TEXT PRIMARY KEY, owner TEXT NOT NULL,
 pet TEXT NOT NULL, bot TEXT NOT NULL, subject TEXT, confirmation_hash TEXT,
 expires INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, stage TEXT NOT NULL);
CREATE TABLE bindings (bot TEXT, subject TEXT, owner TEXT NOT NULL, pet TEXT NOT NULL,
 version INTEGER NOT NULL, active INTEGER NOT NULL, memory_allowed INTEGER NOT NULL,
 PRIMARY KEY(bot,subject));
CREATE TABLE jobs (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, owner TEXT NOT NULL,
 pet TEXT NOT NULL, bot TEXT NOT NULL, subject TEXT NOT NULL, binding_version INTEGER NOT NULL,
 conversation_id TEXT NOT NULL, day INTEGER NOT NULL, created INTEGER NOT NULL,
 status TEXT NOT NULL, model_attempts INTEGER NOT NULL DEFAULT 0,
 delivery_attempts INTEGER NOT NULL DEFAULT 0, budget_cost INTEGER NOT NULL,
 input_tokens INTEGER, output_tokens INTEGER, cache_hit_tokens INTEGER,
 model TEXT NOT NULL DEFAULT 'mock-pet-v1', actual_cost_usd TEXT,
 channel TEXT NOT NULL DEFAULT 'qq-mock-c2c', pricing_version TEXT,
 simulated INTEGER NOT NULL DEFAULT 1, quota_units INTEGER NOT NULL DEFAULT 0,
 account_settled INTEGER NOT NULL DEFAULT 0);
CREATE INDEX jobs_owner_day ON jobs(owner,day);
CREATE INDEX jobs_bot_day ON jobs(bot,day);
"""


class MockStore:
    def __init__(self, pepper: bytes, *, path: Path | None = None, reopen_run: str | None = None):
        if not isinstance(pepper, bytes) or len(pepper) != 32:
            raise Rejected("LAB_PEPPER_REQUIRED")
        self._pepper, self.path = pepper, path
        self._lock = threading.RLock()
        self.run_id = uuid(reopen_run) if reopen_run else str(uuid4())
        tag = self.digest("lab-pepper")
        if path:
            path = Path(path).absolute()
            if any(p.is_symlink() for p in (path, *path.parents)) or not path.parent.is_dir():
                raise Rejected("UNSAFE_LAB_PATH")
            if reopen_run:
                if not path.is_file():
                    raise Rejected("LAB_STORE_MISSING")
                with closing(sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)) as check:
                    try:
                        meta = dict(check.execute("SELECT key,value FROM meta"))
                    except sqlite3.Error:
                        raise Rejected("NOT_A_LAB_STORE") from None
                    if meta != {
                        "namespace": "p87-mock-qq/1",
                        "run": self.run_id,
                        "pepper_tag": tag,
                        "paused": meta.get("paused"),
                    } or meta["paused"] not in {"0", "1"}:
                        raise Rejected("NOT_A_LAB_STORE")
            else:
                try:
                    with path.open("xb"):
                        pass
                except FileExistsError:
                    raise Rejected("LAB_STORE_EXISTS") from None
        elif reopen_run:
            raise Rejected("LAB_STORE_MISSING")
        self.db = sqlite3.connect(path or ":memory:", isolation_level=None, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        if not reopen_run:
            self.db.executescript(SCHEMA)
            self.db.executemany(
                "INSERT INTO meta VALUES (?,?)",
                [
                    ("namespace", "p87-mock-qq/1"),
                    ("run", self.run_id),
                    ("pepper_tag", tag),
                    ("paused", "0"),
                ],
            )
        else:
            # Raw bodies were never persisted. Never regenerate/replay after restart.
            with self.transaction() as db:
                for row in db.execute(
                    "SELECT * FROM jobs WHERE status IN (?,?,?)", ACTIVE
                ).fetchall():
                    self._finish(db, row, "abandoned", None, None)

    def digest(self, *parts) -> str:
        raw = json.dumps(parts, ensure_ascii=False, separators=(",", ":")).encode()
        return hmac.new(self._pepper, raw, hashlib.sha256).hexdigest()

    def subject_hash(self, receipt: Receipt) -> str:
        return self.digest("subject", receipt.bot, receipt.scene, receipt.subject)

    def message_key(self, receipt: Receipt) -> str:
        return self.digest(
            "message",
            receipt.bot,
            receipt.scene,
            receipt.subject,
            receipt.message_id,
            receipt.message_index,
        )

    @contextmanager
    def transaction(self):
        with self._lock:
            self.db.execute("BEGIN IMMEDIATE")
            try:
                yield self.db
                self.db.execute("COMMIT")
            except BaseException:
                self.db.execute("ROLLBACK")
                raise

    def add_bot(self, bot: str, *, manager: str | None = None):
        if manager:
            uuid(manager)
        with self.transaction() as db:
            db.execute("INSERT INTO bots VALUES (?,?,1)", (bot, manager))

    def add_account(self, owner: str, grant: int, *, protected=True):
        if type(grant) is not int or not 1 <= grant <= 10000:
            raise Rejected("INVALID_LAB_GRANT")
        with self.transaction() as db:
            try:
                db.execute(
                    "INSERT INTO accounts(owner,granted,protected) VALUES (?,?,?)",
                    (uuid(owner), grant, int(protected)),
                )
            except sqlite3.IntegrityError:
                raise Rejected("GRANT_ALREADY_INITIALIZED") from None

    def _gate(self, db, bot: str, owner: str | None = None):
        if db.execute("SELECT value FROM meta WHERE key='paused'").fetchone()[0] == "1":
            raise Rejected("PLATFORM_PAUSED")
        channel = db.execute("SELECT * FROM bots WHERE id=?", (bot,)).fetchone()
        if not channel or not channel["enabled"]:
            raise Rejected("BOT_PAUSED")
        if owner:
            account = db.execute("SELECT * FROM accounts WHERE owner=?", (owner,)).fetchone()
            if not account or not account["enabled"]:
                raise Rejected("ACCOUNT_UNAVAILABLE")
            if channel["manager"] and channel["manager"] != owner:
                raise Rejected("BOT_OWNER_DENIED")
        return channel

    def start_binding(self, owner: str, pet: str, bot: str, now: int) -> str:
        token = secrets.token_urlsafe(24)
        with self.transaction() as db:
            self._gate(db, bot, uuid(owner))
            db.execute("DELETE FROM challenges WHERE expires<=?", (now,))
            if (
                db.execute("SELECT count(*) FROM challenges WHERE owner=?", (owner,)).fetchone()[0]
                >= 5
            ):
                raise Rejected("BIND_RATE_LIMIT")
            db.execute(
                "INSERT INTO challenges(token_hash,owner,pet,bot,expires,stage) "
                "VALUES (?,?,?,?,?,'new')",
                (self.digest("bind", token), owner, uuid(pet), bot, now + 300),
            )
        return token

    def observe_binding(self, receipt: Receipt, token: str, now: int) -> str:
        confirm, error = secrets.token_urlsafe(24), None
        key = self.digest("bind", token)
        with self.transaction() as db:
            row = db.execute("SELECT * FROM challenges WHERE token_hash=?", (key,)).fetchone()
            self._gate(db, receipt.bot)
            if not row or row["expires"] <= now or row["stage"] != "new" or row["attempts"] >= 5:
                error = "BIND_UNAVAILABLE"
            elif row["bot"] != receipt.bot or receipt.text != "/bind " + token:
                db.execute("UPDATE challenges SET attempts=attempts+1 WHERE token_hash=?", (key,))
                error = "BIND_PROOF_DENIED"
            else:
                db.execute(
                    "UPDATE challenges SET subject=?,confirmation_hash=?,stage='confirm' "
                    "WHERE token_hash=?",
                    (self.subject_hash(receipt), self.digest("confirm", confirm), key),
                )
        if error:
            raise Rejected(error)
        return confirm

    def confirm_binding(self, owner: str, token: str, confirm: str, now: int, *, memory=False):
        key, error = self.digest("bind", token), None
        with self.transaction() as db:
            row = db.execute("SELECT * FROM challenges WHERE token_hash=?", (key,)).fetchone()
            if not row or row["owner"] != uuid(owner):
                raise Rejected("BIND_OWNER_DENIED")
            self._gate(db, row["bot"], owner)
            if row["expires"] <= now or row["stage"] != "confirm" or row["attempts"] >= 5:
                error = "BIND_UNAVAILABLE"
            elif not hmac.compare_digest(row["confirmation_hash"], self.digest("confirm", confirm)):
                db.execute("UPDATE challenges SET attempts=attempts+1 WHERE token_hash=?", (key,))
                error = "BIND_PROOF_DENIED"
            else:
                old = db.execute(
                    "SELECT * FROM bindings WHERE bot=? AND subject=?", (row["bot"], row["subject"])
                ).fetchone()
                if old and old["active"] and old["owner"] != owner:
                    raise Rejected("IDENTITY_ALREADY_BOUND")
                version = old["version"] + 1 if old else 1
                db.execute(
                    "INSERT OR REPLACE INTO bindings VALUES (?,?,?,?,?,1,?)",
                    (row["bot"], row["subject"], owner, row["pet"], version, int(memory)),
                )
                db.execute("UPDATE challenges SET stage='used' WHERE token_hash=?", (key,))
        if error:
            raise Rejected(error)

    def binding_request(self, owner: str, token: str):
        with self.transaction() as db:
            row = db.execute(
                "SELECT * FROM challenges WHERE token_hash=? AND owner=?",
                (self.digest("bind", token), uuid(owner)),
            ).fetchone()
            if not row:
                raise Rejected("BIND_OWNER_DENIED")
            return dict(row)

    def binding(self, receipt: Receipt) -> Scope:
        with self.transaction() as db:
            row = db.execute(
                "SELECT * FROM bindings WHERE bot=? AND subject=?",
                (receipt.bot, self.subject_hash(receipt)),
            ).fetchone()
            if not row or not row["active"]:
                raise Rejected("BINDING_REQUIRED")
            self._gate(db, row["bot"], row["owner"])
            return Scope(
                row["owner"],
                row["pet"],
                row["bot"],
                row["subject"],
                row["version"],
                bool(row["memory_allowed"]),
            )

    def admission(
        self,
        receipt: Receipt,
        scope: Scope,
        now: int,
        ceiling: int,
        limits: Limits,
        pricing_version: str,
        *,
        channel: str = "qq-mock-c2c",
    ):
        if channel not in {"qq-mock-c2c", "qq-official-sandbox-c2c", "qq-official-ws-sandbox-c2c"}:
            raise Rejected("CHANNEL_NOT_ALLOWED")
        key = self.message_key(receipt)
        fingerprint = self.digest("payload", receipt.text)
        day = now // 86400
        with self.transaction() as db:
            self._gate(db, scope.bot, scope.owner)
            previous = db.execute("SELECT * FROM jobs WHERE id=?", (key,)).fetchone()
            if previous:
                if previous["fingerprint"] != fingerprint:
                    raise Rejected("MESSAGE_CONFLICT")
                if (
                    previous["owner"] != scope.owner
                    or previous["binding_version"] != scope.binding_version
                ):
                    raise Rejected("BINDING_CHANGED")
                return key, False
            a = db.execute("SELECT * FROM accounts WHERE owner=?", (scope.owner,)).fetchone()
            if a["reserved"] + a["spent"] >= a["granted"]:
                raise Rejected("QUOTA_EXHAUSTED")
            if a["protected"] and ((now + 8 * 3600) // 3600) % 24 in {*range(0, 8), 22, 23}:
                raise Rejected("PROTECTED_QUIET_HOURS")
            count = db.execute(
                "SELECT count(*) FROM jobs WHERE owner=? AND day=?", (scope.owner, day)
            ).fetchone()[0]
            daily = (
                limits.protected_daily_messages if a["protected"] else limits.account_daily_messages
            )
            if count >= daily:
                raise Rejected("DAILY_LIMIT")
            for field, value, maximum in [
                ("owner", scope.owner, limits.account_per_minute),
                ("bot", scope.bot, limits.bot_per_minute),
                (None, None, limits.global_per_minute),
            ]:
                sql = "SELECT count(*) FROM jobs WHERE created>?"
                args = [now - 60]
                if field:
                    sql += " AND " + field + "=?"
                    args.append(value)
                if db.execute(sql, args).fetchone()[0] >= maximum:
                    raise Rejected("RATE_LIMIT")
            for field, value, maximum in [
                ("owner", scope.owner, limits.account_daily_micro_usd),
                ("bot", scope.bot, limits.bot_daily_micro_usd),
                (None, None, limits.global_daily_micro_usd),
            ]:
                sql, args = "SELECT coalesce(sum(budget_cost),0) FROM jobs WHERE day=?", [day]
                if field:
                    sql += " AND " + field + "=?"
                    args.append(value)
                if db.execute(sql, args).fetchone()[0] + ceiling > maximum:
                    raise Rejected("BUDGET_EXHAUSTED")
            pending = db.execute(
                "SELECT owner FROM jobs WHERE status IN (?,?,?)", ACTIVE
            ).fetchall()
            if len(pending) >= limits.pending or any(r[0] == scope.owner for r in pending):
                raise Rejected("BUSY")
            db.execute(
                "INSERT INTO jobs(id,fingerprint,owner,pet,bot,subject,binding_version,"
                "conversation_id,day,created,status,budget_cost,pricing_version,channel) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,'admitted',?,?,?)",
                (
                    key,
                    fingerprint,
                    scope.owner,
                    scope.pet,
                    scope.bot,
                    scope.subject_hash,
                    scope.binding_version,
                    scope.conversation_id,
                    day,
                    now,
                    ceiling,
                    pricing_version,
                    channel,
                ),
            )
            db.execute("UPDATE accounts SET reserved=reserved+1 WHERE owner=?", (scope.owner,))
        return key, True

    def state(self, owner: str, key: str):
        with self.transaction() as db:
            row = db.execute(
                "SELECT * FROM jobs WHERE id=? AND owner=?", (key, uuid(owner))
            ).fetchone()
            if not row:
                raise Rejected("JOB_UNAVAILABLE")
            return dict(row)

    def mark(self, owner: str, key: str, status: str):
        if status not in {"generating", "sending"}:
            raise Rejected("INVALID_TRANSITION")
        with self.transaction() as db:
            row = db.execute("SELECT * FROM jobs WHERE id=? AND owner=?", (key, owner)).fetchone()
            expected = {"generating": {"admitted"}, "sending": {"generating", "delivery_failed"}}
            if not row or row["status"] not in expected[status]:
                raise Rejected("INVALID_TRANSITION")
            attempts = row["delivery_attempts"] if status == "sending" else row["model_attempts"]
            if attempts >= (2 if status == "sending" else 1):
                raise Rejected("RETRY_LIMIT")
            field = "delivery_attempts" if status == "sending" else "model_attempts"
            db.execute(f"UPDATE jobs SET status=?,{field}={field}+1 WHERE id=?", (status, key))

    def _finish(self, db, row, status, usage, cost):
        first = not row["account_settled"]
        used = row["model_attempts"] > 0
        charged = (cost if cost is not None else row["budget_cost"]) if used else 0
        db.execute(
            "UPDATE jobs SET status=?,budget_cost=?,input_tokens=?,output_tokens=?,"
            "cache_hit_tokens=?,quota_units=?,account_settled=1 WHERE id=?",
            (
                status,
                charged,
                usage.input_tokens if usage else None,
                usage.output_tokens if usage else None,
                usage.cache_hit_tokens if usage else None,
                int(used),
                row["id"],
            ),
        )
        if first:
            db.execute(
                "UPDATE accounts SET reserved=reserved-1,spent=spent+? WHERE owner=?",
                (int(used), row["owner"]),
            )

    def finish(self, owner, key, status, usage=None, cost=None):
        with self.transaction() as db:
            row = db.execute("SELECT * FROM jobs WHERE id=? AND owner=?", (key, owner)).fetchone()
            if not row or row["status"] not in {*ACTIVE, "delivery_failed"}:
                raise Rejected("INVALID_TRANSITION")
            self._finish(db, row, status, usage, cost)

    def protected(self, owner):
        return bool(
            self.db.execute("SELECT protected FROM accounts WHERE owner=?", (owner,)).fetchone()[0]
        )

    def list_bindings(self, owner):
        with self.transaction() as db:
            return [
                dict(row)
                for row in db.execute(
                    "SELECT bot,pet,subject AS subject_hmac,version,active,memory_allowed "
                    "FROM bindings WHERE owner=? ORDER BY bot,subject",
                    (uuid(owner),),
                )
            ]

    def pause(self, bot: str | None = None):
        with self.transaction() as db:
            if bot:
                db.execute("UPDATE bots SET enabled=0 WHERE id=?", (bot,))
            else:
                db.execute("UPDATE meta SET value='1' WHERE key='paused'")

    def revoke(self, owner, bot, subject_hash):
        with self.transaction() as db:
            result = db.execute(
                "UPDATE bindings SET active=0,memory_allowed=0,version=version+1 "
                "WHERE bot=? AND subject=? AND owner=?",
                (bot, subject_hash, uuid(owner)),
            )
            if result.rowcount != 1:
                raise Rejected("BIND_OWNER_DENIED")

    def close(self):
        self.db.close()
