from fastapi import APIRouter

from app.modules.admin.router import router as admin
from app.modules.applications.router import router as applications
from app.modules.auth.router import router as auth
from app.modules.community.router import router as community
from app.modules.companion.router import router as companion
from app.modules.memory.router import router as memory
from app.modules.moderation.router import router as moderation
from app.modules.pet_instances.router import router as pet_instances
from app.modules.pets.router import router as pets
from app.modules.users.router import router as users
from app.modules.wallet.router import router as wallet

router = APIRouter(prefix="/api/v1")
for domain_router in (
    auth,
    users,
    community,
    companion,
    pets,
    pet_instances,
    memory,
    wallet,
    applications,
    moderation,
    admin,
):
    router.include_router(domain_router)
