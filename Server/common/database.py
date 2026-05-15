import os
from sqlalchemy import create_engine
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker
from dotenv import load_dotenv

load_dotenv()

DATABASE_URL = os.getenv("DATABASE_URL")

if not DATABASE_URL:
    raise RuntimeError(
        "DATABASE_URL is not set. The app is configured to use RDS only — "
        "set DATABASE_URL in Server/.env."
    )

# Guard against accidentally running against local Postgres.
# If you ever need local for a one-off, set ALLOW_LOCAL_DB=true.
_lowered = DATABASE_URL.lower()
if (("@127.0.0.1" in _lowered or "@localhost" in _lowered or "@::1" in _lowered)
        and (os.getenv("ALLOW_LOCAL_DB", "").lower() not in ("1", "true", "yes"))):
    raise RuntimeError(
        f"DATABASE_URL points at local Postgres ({DATABASE_URL.split('@')[-1].split('/')[0]}); "
        "this deployment is RDS-only. Override with ALLOW_LOCAL_DB=true if you really mean it."
    )

engine = create_engine(DATABASE_URL)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

Base = declarative_base()

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
