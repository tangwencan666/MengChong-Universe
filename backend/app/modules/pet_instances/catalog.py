"""Public species templates, independent of private pet instance identities."""

import json
from pathlib import Path

from app.core.errors import AppError
from app.modules.pets.schemas import PetCreate, PetView

LEGACY_SPECIES = ("moon", "doubao", "xiaoyun", "maodie", "hajimi")
SPECIES = (*LEGACY_SPECIES, "niwa", "daodun", "whale")
_assets = Path(__file__).resolve().parents[4] / "desktop/assets"
_document = json.loads((_assets / "pet-definitions.json").read_text(encoding="utf-8"))
TEMPLATES = {item["id"]: item for item in _document["pets"]}
if set(TEMPLATES) != set(SPECIES):
    raise RuntimeError("Reviewed eight-species catalog required")
_appearances = json.loads((_assets / "p85-appearances.json").read_text(encoding="utf-8"))
APPEARANCES = {item["appearance_id"]: item for item in _appearances["appearances"]}
DEFAULT_APPEARANCE = {item["species_id"]: item for item in APPEARANCES.values()}
if set(DEFAULT_APPEARANCE) != set(SPECIES):
    raise RuntimeError("Reviewed species/appearance association required")


def configuration(species_id, name=None, persona=None, appearance_id=None):
    item = TEMPLATES[species_id]
    appearance = APPEARANCES.get(appearance_id) if appearance_id else DEFAULT_APPEARANCE[species_id]
    if not appearance or appearance["species_id"] != species_id:
        raise AppError(422, "APPEARANCE_SPECIES_MISMATCH", "外观与所选宠物种类不匹配。")
    asset = (
        species_id
        if species_id in LEGACY_SPECIES and not appearance_id
        else appearance["appearance_id"]
    )
    return PetCreate(
        name=name or item["name"],
        role_type=item["role_type"],
        persona_config=persona or {"description": item["persona"], "tone": item["tone"]},
        appearance_config={"asset_id": asset, "tint": item["tint"], "scale": 1.0},
    )


def instance(value: PetView, owner):
    asset = value.appearance_config.asset_id
    registered = asset in SPECIES or asset in APPEARANCES
    species = (
        (asset if asset in SPECIES else APPEARANCES[asset]["species_id"])
        if registered
        else {"cat": "moon", "dog": "doubao", "custom": "xiaoyun"}.get(value.role_type, "xiaoyun")
    )
    return {
        **value.model_dump(mode="json"),
        "species_id": species,
        "species_source": "registered_asset" if registered else "legacy_role",
        "pet_instance_id": str(value.pet_id),
        "owner_user_id": str(owner),
        "appearance_id": (APPEARANCES.get(asset) or DEFAULT_APPEARANCE[species])["appearance_id"],
        "personality_snapshot": value.persona_config.model_dump(mode="json"),
        "personality_snapshot_version": value.version,
    }
