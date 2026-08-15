"""Auth routes: Google login only (multi-user isolation)."""
from __future__ import annotations

from fastapi import APIRouter, Depends, Header
from sqlalchemy import delete
from sqlalchemy.orm import Session

from ..auth import create_session, get_current_user, get_or_create_google_user, verify_google_id_token
from ..database import get_db
from ..models import Session as SessionRow
from ..schemas import AuthResponse, LoginGoogle, UserOut

router = APIRouter(prefix="/api/auth", tags=["auth"])


def _user_out(u) -> UserOut:
    return UserOut(id=u.id, email=u.email, display_name=u.display_name, auth_source=u.auth_source)


@router.post("/google", response_model=AuthResponse)
def login_google(body: LoginGoogle, db: Session = Depends(get_db)):
    info = verify_google_id_token(body.id_token)
    user = get_or_create_google_user(db, info)
    token = create_session(db, user.id)
    return AuthResponse(token=token, user=_user_out(user))


@router.get("/me", response_model=UserOut)
def me(user=Depends(get_current_user)):
    return _user_out(user)


@router.post("/logout", status_code=204)
def logout(user=Depends(get_current_user), db: Session = Depends(get_db),
           authorization: str = Header(default="")):
    token = authorization.split(" ", 1)[1] if authorization.lower().startswith("bearer ") else ""
    if token:
        db.execute(delete(SessionRow).where(SessionRow.token == token))
        db.commit()
    return None
