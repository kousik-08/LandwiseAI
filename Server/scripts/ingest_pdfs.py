import os
import json
from sqlalchemy import create_engine, Column, Integer, String, Text, ForeignKey, TIMESTAMP, LargeBinary, func, text
from sqlalchemy.orm import declarative_base, sessionmaker
from dotenv import load_dotenv

# Load database configuration
load_dotenv()

DATABASE_URL = os.getenv("DATABASE_URL")
if not DATABASE_URL:
    DATABASE_URL = "sqlite:///./landwiseai.db"

# Database Setup
engine = create_engine(DATABASE_URL)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


# Define Models
class Folder(Base):
    __tablename__ = "folders"
    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(Text, nullable=False)
    parent_id = Column(Integer, ForeignKey("folders.id"), nullable=True)


class PDFFile(Base):
    __tablename__ = "pdf_files"
    id = Column(Integer, primary_key=True, autoincrement=True)
    file_name = Column(Text, nullable=False)
    file_path = Column(Text, unique=True, nullable=False)
    folder_id = Column(Integer, ForeignKey("folders.id"))
    file_size = Column(Integer)
    file_data = Column(LargeBinary, nullable=True)  # Actual PDF binary
    uploaded_at = Column(TIMESTAMP, server_default=func.now())


def ensure_file_data_column(engine):
    """Add file_data column if it doesn't exist (for existing tables)."""
    try:
        with engine.connect() as conn:
            conn.execute(text(
                "ALTER TABLE pdf_files ADD COLUMN IF NOT EXISTS file_data BYTEA"
            ))
            conn.commit()
    except Exception:
        pass  # Column already exists or DB doesn't support IF NOT EXISTS


def ingest_pdfs(source_path):
    summary = {
        "total_files_found": 0,
        "files_inserted": 0,
        "duplicates_skipped": 0,
        "errors": []
    }

    if not os.path.exists(source_path):
        summary["errors"].append(f"Source path does not exist: {source_path}")
        return summary

    # Create tables if not exists, then ensure file_data column
    Base.metadata.create_all(bind=engine)
    ensure_file_data_column(engine)

    db = SessionLocal()

    try:
        # Cache for folders: {abs_path: folder_id}
        folder_cache = {}

        # Traverse directory recursively
        for root, dirs, files in os.walk(source_path):
            abs_root = os.path.abspath(root)

            # Resolve folder hierarchy
            if abs_root == os.path.abspath(source_path):
                folder_name = os.path.basename(abs_root)
                folder = db.query(Folder).filter(
                    Folder.name == folder_name, Folder.parent_id == None
                ).first()
                if not folder:
                    folder = Folder(name=folder_name, parent_id=None)
                    db.add(folder)
                    db.commit()
                    db.refresh(folder)
                folder_cache[abs_root] = folder.id
            else:
                parent_path = os.path.dirname(abs_root)
                parent_id = folder_cache.get(parent_path)
                folder_name = os.path.basename(abs_root)

                folder = db.query(Folder).filter(
                    Folder.name == folder_name, Folder.parent_id == parent_id
                ).first()
                if not folder:
                    folder = Folder(name=folder_name, parent_id=parent_id)
                    db.add(folder)
                    db.commit()
                    db.refresh(folder)
                folder_cache[abs_root] = folder.id

            current_folder_id = folder_cache[abs_root]

            # Process PDF files
            for file in files:
                if not file.lower().endswith(".pdf"):
                    continue

                summary["total_files_found"] += 1
                full_path = os.path.abspath(os.path.join(root, file))

                try:
                    # Duplicate check
                    existing = db.query(PDFFile).filter(PDFFile.file_path == full_path).first()
                    if existing:
                        # If it exists but has no binary data, update it
                        if existing.file_data is None:
                            with open(full_path, "rb") as f:
                                existing.file_data = f.read()
                            db.commit()
                            summary["files_inserted"] += 1
                            print(f"  [UPDATE] Binary stored for: {file}")
                        else:
                            summary["duplicates_skipped"] += 1
                        continue

                    # Read binary content
                    with open(full_path, "rb") as f:
                        file_bytes = f.read()

                    file_size = os.path.getsize(full_path)
                    new_file = PDFFile(
                        file_name=file,
                        file_path=full_path,
                        folder_id=current_folder_id,
                        file_size=file_size,
                        file_data=file_bytes
                    )
                    db.add(new_file)
                    db.commit()
                    summary["files_inserted"] += 1
                    print(f"  [INSERT] {file} ({file_size:,} bytes)")

                except Exception as e:
                    db.rollback()
                    summary["errors"].append(f"Failed on {file}: {str(e)}")

    except Exception as e:
        db.rollback()
        summary["errors"].append(f"Critical error: {str(e)}")
    finally:
        db.close()

    return summary


if __name__ == "__main__":
    SOURCE_PATH = r"D:\Master_legal_AI_Stable_Hierarchy - Copy - Copy\Server\outputs\validate\6e60e76d-ce49-4d77-93f9-ede48be94a91"

    if not os.path.exists(SOURCE_PATH):
        alt = os.path.abspath(os.path.join(
            os.getcwd(), "outputs", "validate",
            "6e60e76d-ce49-4d77-93f9-ede48be94a91"
        ))
        if os.path.exists(alt):
            SOURCE_PATH = alt

    print(f"[*] Ingesting PDFs from: {SOURCE_PATH}")
    results = ingest_pdfs(SOURCE_PATH)
    print("\n" + json.dumps(results, indent=2))
