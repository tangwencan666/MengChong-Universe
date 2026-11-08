"""Single explicit registry used by Alembic and mapper configuration."""

from app.modules.applications.models import JobApplication
from app.modules.auth.models import AuthSession, EmailVerification, PasswordReset
from app.modules.community.models import Comment, Post, PostLike, Report
from app.modules.companion.models import (
    AICompanion,
    ChatGeneration,
    ChatGenerationEvent,
    ChatMessage,
    ChatPreferences,
    ChatSession,
)
from app.modules.memory.models import (
    Memory,
    MemoryConsentEvent,
    MemoryGenerationRef,
    MemoryOperation,
    MemoryPreferences,
    MemorySource,
)
from app.modules.moderation.models import ModerationAction
from app.modules.pets.models import (
    Pet,
    PetChatBinding,
    PetGenerationContext,
    PetMemory,
    PetMemoryConsent,
    PetMemoryOperation,
    PetMemoryPreferences,
    PetMemorySource,
)
from app.modules.users.models import User
from app.modules.wallet.models import UsageRecord, Wallet, WalletReservation, WalletTransaction
