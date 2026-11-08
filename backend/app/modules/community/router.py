from uuid import UUID

from fastapi import APIRouter, Depends, Query

from app.core.errors import NotImplementedFeature
from app.core.security import get_principal
from app.modules.community.schemas import CreatePost, PublicPost

router = APIRouter(prefix="/community", tags=["community"])


@router.get("/posts", response_model=list[PublicPost])
async def list_posts(limit: int = Query(default=20, ge=1, le=100)):  # noqa: B008
    raise NotImplementedFeature("已审核公开帖子列表与游标分页")


@router.get("/posts/{post_id}", response_model=PublicPost)
async def get_post(post_id: UUID):
    raise NotImplementedFeature("公开帖子详情与可见性过滤")


@router.post("/posts", dependencies=[Depends(get_principal)])
async def create_post(payload: CreatePost):
    raise NotImplementedFeature("发帖与内容审核")


@router.get("/posts/{post_id}/comments")
async def list_comments(post_id: UUID):
    raise NotImplementedFeature("公开评论列表")
