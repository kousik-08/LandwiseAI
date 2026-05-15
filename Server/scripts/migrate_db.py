import sys
import os
from sqlalchemy import text
from sqlalchemy.exc import ProgrammingError

# Add the parent directory to sys.path to import common
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from common.database import engine, Base
from common.landwise_models import User, Role

def migrate():
    print("Connecting to database to apply migrations...")
    with engine.connect() as conn:
        # Add password_hash if it doesn't exist
        try:
            conn.execute(text("ALTER TABLE users ADD COLUMN password_hash VARCHAR(255)"))
            conn.commit()
            print("Added password_hash column.")
        except ProgrammingError as e:
            conn.rollback()
            if "already exists" in str(e):
                print("password_hash column already exists.")
            else:
                raise e

        # Add role_id if it doesn't exist
        try:
            conn.execute(text("ALTER TABLE users ADD COLUMN role_id VARCHAR"))
            conn.execute(text("ALTER TABLE users ADD CONSTRAINT fk_user_role FOREIGN KEY (role_id) REFERENCES roles (id)"))
            conn.commit()
            print("Added role_id column and foreign key.")
        except ProgrammingError as e:
            conn.rollback()
            if "already exists" in str(e):
                print("role_id column already exists.")
            else:
                raise e

        # Add system_role if it doesn't exist
        try:
            conn.execute(text("ALTER TABLE users ADD COLUMN system_role VARCHAR(50)"))
            conn.commit()
            print("Added system_role column.")
        except ProgrammingError as e:
            conn.rollback()
            if "already exists" in str(e):
                print("system_role column already exists.")
            else:
                raise e

    print("Migration check complete.")

if __name__ == "__main__":
    migrate()
