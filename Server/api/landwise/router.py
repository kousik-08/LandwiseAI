"""
Landwise API Router — Full CRUD for Projects, Parcels, Documents, 
Checklist, Risk Flags, Consistency, Opinions, and Notifications
================================================================
Mounted at /api/v1/landwise/ in the main app.
"""

import os
import json
import uuid
import hashlib
import logging
from datetime import datetime
from typing import Optional, List

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session
from sqlalchemy import func, desc

from common.database import get_db
from common.landwise_models import (
    User, Role, Project, ProjectTeamAssignment, Parcel,
    LandwiseDocument, ExtractedField, ExtractionJob,
    DocumentAnnotation, Owner, OwnershipTransfer,
    Encumbrance, RiskFlag, ConsistencyCheck, ConsistencyMismatch,
    ChecklistItem, LegalOpinion, OpinionSection,
    AuditLog, Notification, ExternalFetchLog, AnalysisResult, gen_uuid
)
from services.gatekeeper import GatekeeperService
from services.audit_service import AuditService
from services.checklist_service import ChecklistService
from services.analysis_bridge import AnalysisBridge
from api.validate.handler import handle_validate
import shutil
import zipfile
import tempfile

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/landwise", tags=["Landwise"])


# ══════════════════════════════════════════════════════════════
#  REQUEST / RESPONSE MODELS
# ══════════════════════════════════════════════════════════════

# ── Projects ──
class ProjectCreate(BaseModel):
    name: str
    description: Optional[str] = None
    district: str = "Unknown"
    state: str = "Tamil Nadu"
    project_type: Optional[str] = "Land Acquisition"
    project_icon: Optional[str] = "building"
    legal_advisor_id: Optional[str] = None
    target_acquisition_date: Optional[str] = None

class ProjectUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    status: Optional[str] = None

# ── Parcels ──
class ParcelCreate(BaseModel):
    survey_number: str
    subdivision: Optional[str] = None
    district: str
    taluk: str
    village: str
    area_acres: Optional[float] = None
    land_use_type: Optional[str] = None

class ParcelUpdate(BaseModel):
    status: Optional[str] = None
    area_acres: Optional[float] = None
    land_use_type: Optional[str] = None
    assigned_lawyer_id: Optional[str] = None

# ── Team Assignment ──
class AssignmentItem(BaseModel):
    user_id: str
    role: str

class TeamAssignRequest(BaseModel):
    assignments: List[AssignmentItem]

# ── Annotations ──
class AnnotationCreate(BaseModel):
    document_id: str
    annotation_type: str  # risk, query, verified, condition, note
    selected_text: str
    note: Optional[str] = None
    page_number: int = 1
    bounding_box: Optional[dict] = None

# ── Checklist ──
class ChecklistVerdictUpdate(BaseModel):
    verdict: str  # clear, caution, fail, na
    lawyer_notes: Optional[str] = None

# ── Risk Flags ──
class RiskFlagAction(BaseModel):
    action: str  # accepted, dismissed, escalated
    action_note: Optional[str] = None

# ── Field Override ──
class FieldOverride(BaseModel):
    overridden_value: str

# ── Opinion ──
class OpinionSectionUpdate(BaseModel):
    final_content: str
    is_accepted: bool = False

class OpinionVerdictSet(BaseModel):
    verdict: str  # safe_to_proceed, proceed_with_caution, do_not_proceed

# ── Consistency ──
class MismatchAction(BaseModel):
    lawyer_action: str  # acceptable, queried
    lawyer_note: Optional[str] = None


# ══════════════════════════════════════════════════════════════
#  EP #01-02: PROJECTS
# ══════════════════════════════════════════════════════════════

@router.post("/projects", status_code=201)
def create_project(body: ProjectCreate, db: Session = Depends(get_db)):
    """EP #01: Create a new real-estate project."""
    project = Project(
        id=gen_uuid(),
        name=body.name,
        description=body.description,
        district=body.district,
        state=body.state,
        project_type=body.project_type,
        project_icon=body.project_icon,
        legal_advisor_id=body.legal_advisor_id
    )
    if body.target_acquisition_date:
        try:
            project.target_acquisition_date = datetime.strptime(
                body.target_acquisition_date, "%Y-%m-%d"
            ).date()
        except ValueError:
            pass

    db.add(project)
    
    # Auto-assign legal advisor to the project team if provided
    if body.legal_advisor_id:
        assignment = ProjectTeamAssignment(
            id=gen_uuid(),
            project_id=project.id,
            user_id=body.legal_advisor_id,
            role='legal_advisor'
        )
        db.add(assignment)

    db.commit()
    db.refresh(project)
    return project

@router.get("/legal-advisors")
def list_legal_advisors(db: Session = Depends(get_db)):
    """List all users with the legal_advisor role."""
    # Find the role ID for legal_advisor
    role = db.query(Role).filter(Role.name == 'legal_advisor').first()
    if not role:
        return []
    
    advisors = db.query(User).filter(User.role_id == role.id).all()
    return [{"id": u.id, "full_name": u.full_name, "email": u.email} for u in advisors]

@router.get("/projects")
def list_projects(db: Session = Depends(get_db)):
    """EP #02: List all projects."""
    projects = db.query(Project).order_by(desc(Project.created_at)).all()
    return {"data": projects}

@router.get("/projects/{project_id}")
def get_project(project_id: str, db: Session = Depends(get_db)):
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(404, "Project not found")
    return project

@router.get("/dashboard/{project_id}")
def get_project_dashboard(project_id: str, db: Session = Depends(get_db)):
    """Summary stats for a project dashboard."""
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(404, "Project not found")
        
    parcels = db.query(Parcel).filter(Parcel.project_id == project_id, Parcel.is_active == True).all()
    parcel_ids = [p.id for p in parcels]
    
    total_parcels = len(parcels)
    pending = len([p for p in parcels if p.status == 'pending'])
    in_review = len([p for p in parcels if p.status == 'in_review'])
    completed = len([p for p in parcels if p.status == 'completed'])
    
    risk_flags = db.query(RiskFlag).filter(RiskFlag.parcel_id.in_(parcel_ids)).count()
    docs_total = db.query(LandwiseDocument).filter(
        LandwiseDocument.parcel_id.in_(parcel_ids),
        LandwiseDocument.deleted_at.is_(None)
    ).count()
    
    return {
        "project_name": project.name,
        "stats": {
            "total_parcels": total_parcels,
            "pending": pending,
            "in_review": in_review,
            "completed": completed,
            "risk_flags": risk_flags,
            "total_documents": docs_total
        },
        "parcels": [{
            "id": p.id,
            "survey_number": p.survey_number,
            "status": p.status,
            "risk_score": p.risk_score,
            "village": p.village
        } for p in parcels]
    }

@router.get("/team")
def list_available_team(db: Session = Depends(get_db)):
    """List all legal team members for assignment."""
    users = db.query(User).all()
    return {"data": [{
        "id": u.id,
        "full_name": u.full_name,
        "role": u.role,
        "email": u.email
    } for u in users]}

# ══════════════════════════════════════════════════════════════
#  EP #03-06: PARCELS
# ══════════════════════════════════════════════════════════════

@router.get("/projects/{project_id}/parcels")
def list_parcels(project_id: str, db: Session = Depends(get_db)):
    parcels = db.query(Parcel).filter(Parcel.project_id == project_id, Parcel.is_active == True).all()
    return {"data": parcels}

@router.post("/projects/{project_id}/parcels", status_code=201)
def create_parcel(project_id: str, body: ParcelCreate, db: Session = Depends(get_db)):
    # Check if an ACTIVE parcel with same survey number already exists
    existing_active = db.query(Parcel).filter(
        Parcel.project_id == project_id,
        Parcel.survey_number == body.survey_number,
        Parcel.subdivision == body.subdivision,
        Parcel.is_active == True
    ).first()
    
    if existing_active:
        raise HTTPException(400, f"Survey number '{body.survey_number}' already exists in this project")
    
    # Check if a SOFT-DELETED parcel with same survey number exists - restore it instead
    existing_deleted = db.query(Parcel).filter(
        Parcel.project_id == project_id,
        Parcel.survey_number == body.survey_number,
        Parcel.subdivision == body.subdivision,
        Parcel.is_active == False
    ).first()
    
    if existing_deleted:
        # Restore the deleted parcel with new data
        existing_deleted.is_active = True
        existing_deleted.deleted_at = None
        existing_deleted.status = "pending"
        # Update fields with new values
        existing_deleted.district = body.district
        existing_deleted.taluk = body.taluk
        existing_deleted.village = body.village
        existing_deleted.area_acres = body.area_acres
        existing_deleted.land_use_type = body.land_use_type
        
        db.commit()
        db.refresh(existing_deleted)
        
        return {
            "status": "restored",
            "message": f"Survey '{body.survey_number}' was previously deleted and has been restored with new data.",
            "parcel": existing_deleted
        }
    
    # Create new parcel if no existing one found
    parcel = Parcel(
        id=gen_uuid(),
        project_id=project_id,
        survey_number=body.survey_number,
        subdivision=body.subdivision,
        district=body.district,
        taluk=body.taluk,
        village=body.village,
        area_acres=body.area_acres,
        land_use_type=body.land_use_type,
        status="pending"
    )
    db.add(parcel)
    db.commit()
    
    # Initialize checklist
    ChecklistService.create_default_checklist(parcel.id, db)
    
    db.refresh(parcel)
    return parcel

@router.get("/parcels/{parcel_id}")
def get_parcel(parcel_id: str, db: Session = Depends(get_db)):
    parcel = db.query(Parcel).filter(Parcel.id == parcel_id, Parcel.is_active == True).first()
    if not parcel:
        raise HTTPException(404, "Parcel not found or has been deleted")
    return parcel

@router.patch("/parcels/{parcel_id}")
def update_parcel(parcel_id: str, body: ParcelUpdate, db: Session = Depends(get_db)):
    parcel = db.query(Parcel).filter(Parcel.id == parcel_id, Parcel.is_active == True).first()
    if not parcel:
        raise HTTPException(404, "Parcel not found or has been deleted")
    
    if body.status:
        AuditService.log_status_change(db, "parcel", parcel.id, parcel.status, body.status, parcel.id, parcel.project_id)
        parcel.status = body.status
    if body.area_acres is not None:
        parcel.area_acres = body.area_acres
    if body.land_use_type:
        parcel.land_use_type = body.land_use_type
    if body.assigned_lawyer_id:
        parcel.assigned_lawyer_id = body.assigned_lawyer_id
        
    db.commit()
    db.refresh(parcel)
    return parcel


# ══════════════════════════════════════════════════════════════
#  EP #07-09: DOCUMENTS
# ══════════════════════════════════════════════════════════════

@router.post("/parcels/{parcel_id}/documents", status_code=201)
async def upload_document(
    parcel_id: str,
    file: UploadFile = File(...),
    document_type: str = Form(...),
    language: str = Form("tamil"),
    year_from: Optional[int] = Form(None),
    year_to: Optional[int] = Form(None),
    source: str = Form("uploaded"),
    db: Session = Depends(get_db)
):
    """EP #07: Upload a document to a parcel."""
    parcel = db.query(Parcel).filter(Parcel.id == parcel_id, Parcel.is_active == True).first()
    if not parcel:
        raise HTTPException(404, "Parcel not found or has been deleted")

    # Scratch lives under tmp/; canonical store is S3 under outputs/documents/<parcel_id>/.
    from common.storage_sync import sync_file as _sync_file, sync_dir as _sync_dir
    scratch_dir = os.path.join("tmp", "work", "_documents", parcel_id)
    os.makedirs(scratch_dir, exist_ok=True)
    s3_doc_prefix = f"outputs/documents/{parcel_id}"

    file_content = await file.read()
    file_hash = hashlib.sha256(file_content).hexdigest()

    # Check duplicate
    existing = db.query(LandwiseDocument).filter(
        LandwiseDocument.parcel_id == parcel_id,
        LandwiseDocument.checksum_sha256 == file_hash,
        LandwiseDocument.deleted_at.is_(None)
    ).first()
    if existing:
        if existing.document_type != document_type:
            existing.document_type = document_type
            db.commit()
            return {
                "id": existing.id,
                "document_type": existing.document_type,
                "status": "updated",
                "message": f"Document type updated to {document_type}."
            }
        return {
            "id": existing.id,
            "document_type": existing.document_type,
            "status": "duplicate_ignored",
            "message": "File already exists with the same type. Ignored."
        }

    file_path = os.path.join(scratch_dir, file.filename)
    with open(file_path, "wb") as f:
        f.write(file_content)
    file_key = f"{s3_doc_prefix}/{file.filename}"
    try:
        _sync_file(file_path, key=file_key)
    except Exception as _e:
        print(f"Document upload sync failed: {_e}")

    docs_to_create = []

    # Process ZIP — extract under scratch, register each child, sync each to S3.
    if file.filename.lower().endswith(".zip") and document_type.lower() == 'sale_deed':
        try:
            with zipfile.ZipFile(file_path, "r") as zip_ref:
                ext_name = f"ext_{gen_uuid()[:8]}"
                extracted_dir = os.path.join(scratch_dir, ext_name)
                os.makedirs(extracted_dir, exist_ok=True)
                zip_ref.extractall(extracted_dir)
                try:
                    _sync_dir(extracted_dir, key_prefix=f"{s3_doc_prefix}/{ext_name}")
                except Exception as _e:
                    print(f"Extracted dir sync failed: {_e}")

                for root, _, files in os.walk(extracted_dir):
                    for f_name in files:
                        if f_name.lower().endswith(".pdf"):
                            full_p = os.path.join(root, f_name)
                            size = os.path.getsize(full_p)
                            rel = os.path.relpath(full_p, extracted_dir).replace("\\", "/")
                            child_key = f"{s3_doc_prefix}/{ext_name}/{rel}"

                            detected_type = 'SALE_DEED'
                            if 'ec' in f_name.lower() or 'encumbrance' in f_name.lower():
                                detected_type = 'ENCUMBRANCE_CERTIFICATE'
                            elif 'patta' in f_name.lower():
                                detected_type = 'PATTA'

                            with open(full_p, 'rb') as pf:
                                pdf_bytes = pf.read()
                            new_doc = LandwiseDocument(
                                id=gen_uuid(),
                                parcel_id=parcel_id,
                                document_type=detected_type,
                                source=source,
                                original_filename=f_name,
                                storage_key=child_key,
                                file_content=pdf_bytes,
                                mime_type='application/pdf',
                                file_size_bytes=size,
                                language=language,
                                extraction_status='pending',
                            )
                            db.add(new_doc)
                            docs_to_create.append(new_doc)
        except Exception as e:
            logger.error(f"ZIP Extraction failed: {e}")

    if not docs_to_create:
        doc = LandwiseDocument(
            id=gen_uuid(),
            parcel_id=parcel_id,
            document_type=document_type,
            source=source,
            original_filename=file.filename,
            storage_key=file_key,
            file_content=file_content,
            mime_type=file.content_type if file.content_type and file.content_type != 'application/octet-stream' else ("application/zip" if file.filename.endswith(".zip") else "application/pdf"),
            file_size_bytes=len(file_content),
            language=language,
            year_from=year_from,
            year_to=year_to,
            extraction_status='pending',
            checksum_sha256=file_hash,
        )
        db.add(doc)
        docs_to_create.append(doc)

    db.commit()
    
    for d in docs_to_create:
        db.refresh(d)
        job = ExtractionJob(
            id=gen_uuid(),
            document_id=d.id,
            status='queued',
        )
        db.add(job)
    
    # Auto-transition parcel pending → in_review
    if parcel.status == 'pending':
        parcel.status = 'in_review'
        AuditService.log_status_change(db, entity_type="parcel", entity_id=parcel.id,
                                       old_status="pending", new_status="in_review",
                                       parcel_id=parcel.id, project_id=parcel.project_id)

    db.commit()

    # S3 has everything we need now — wipe the local scratch.
    try:
        import shutil as _shutil
        _shutil.rmtree(scratch_dir, ignore_errors=True)
    except Exception as _e:
        print(f"Scratch cleanup failed for {scratch_dir}: {_e}")

    return {
        "id": docs_to_create[0].id,
        "document_type": docs_to_create[0].document_type,
        "extraction_status": docs_to_create[0].extraction_status,
        "child_docs_created": len(docs_to_create),
        "checksum_sha256": file_hash,
    }

@router.get("/parcels/{parcel_id}/documents")
def list_documents(
    parcel_id: str,
    document_type: Optional[str] = None,
    extraction_status: Optional[str] = None,
    db: Session = Depends(get_db)
):
    """EP #08: List all documents for a parcel."""
    q = db.query(LandwiseDocument).filter(
        LandwiseDocument.parcel_id == parcel_id,
        LandwiseDocument.deleted_at.is_(None)
    )
    if document_type:
        q = q.filter(LandwiseDocument.document_type == document_type)
    if extraction_status:
        q = q.filter(LandwiseDocument.extraction_status == extraction_status)

    docs = q.order_by(desc(LandwiseDocument.uploaded_at)).all()

    return {
        "data": [{
            "id": d.id, "document_type": d.document_type,
            "original_filename": d.original_filename,
            "source": d.source, "language": d.language,
            "extraction_status": d.extraction_status,
            "extraction_confidence": float(d.extraction_confidence) if d.extraction_confidence else None,
            "year_from": d.year_from, "year_to": d.year_to,
            "file_size_bytes": d.file_size_bytes,
            "annotation_count": db.query(DocumentAnnotation).filter(
                DocumentAnnotation.document_id == d.id
            ).count(),
            "uploaded_at": str(d.uploaded_at),
        } for d in docs],
    }

@router.get("/documents/download/{document_id}")
def download_document(document_id: str, db: Session = Depends(get_db)):
    """EP #09.5: Get document file content. Tries storage backend first
    (S3 presigned redirect), then DB file_content, then local disk."""
    doc = db.query(LandwiseDocument).filter(LandwiseDocument.id == document_id).first()
    if not doc:
        raise HTTPException(404, "Document not found in database")

    from fastapi.responses import FileResponse, Response, RedirectResponse
    from common.storage import get_storage

    storage = get_storage()

    # 1. Storage backend (S3) — preferred, returns a presigned URL the
    #    browser can stream directly.
    if doc.storage_key:
        try:
            if storage.exists(doc.storage_key):
                return RedirectResponse(url=storage.presigned_url(doc.storage_key), status_code=302)
        except Exception as e:
            print(f"[!] storage.presigned_url failed for {doc.storage_key}: {e}")

    # 2. DB file_content fallback.
    if doc.file_content:
        return Response(
            content=doc.file_content,
            media_type="application/pdf",
            headers={"Content-Disposition": f"inline; filename={doc.original_filename}"}
        )

    # 3. Last-resort local disk (legacy rows whose storage_key is an absolute path).
    if doc.storage_key and os.path.isabs(doc.storage_key) and os.path.exists(doc.storage_key):
        return FileResponse(
            path=doc.storage_key,
            media_type="application/pdf",
            filename=doc.original_filename,
            content_disposition_type="inline",
        )

    raise HTTPException(404, "Document file not found in storage, database, or disk")


@router.get("/documents/download-by-path")
def download_document_by_path(file_path: str, db: Session = Depends(get_db)):
    """EP #09.6: Resolve a path string to an S3 presigned URL.

    The path may arrive in any of these forms:
      - "outputs/validate/<id>/matched_docs/<file>.pdf"  (canonical S3 key)
      - "validate/<id>/matched_docs/<file>.pdf"          (missing outputs/ prefix)
      - "inputs/validate/<id>/sale_deeds/<file>.pdf"
      - "<file>.pdf"                                      (vault-style)
    """
    import re
    from fastapi.responses import Response, RedirectResponse
    from common.storage import get_storage

    if ".." in file_path or file_path.startswith("/"):
        raise HTTPException(400, "Invalid file path")

    storage = get_storage()
    norm = file_path.replace("\\", "/").lstrip("./").lstrip("/")
    base = os.path.basename(norm)

    # Build candidate S3 keys covering the various ways the frontend
    # might reference the same file.
    candidates: list[str] = [norm]
    if not (norm.startswith("outputs/") or norm.startswith("inputs/")):
        candidates += [
            f"outputs/{norm}",
            f"inputs/{norm}",
            f"outputs/storage/vault/{base}",
        ]

    for key in candidates:
        try:
            if storage.exists(key):
                return RedirectResponse(url=storage.presigned_url(key), status_code=302)
        except Exception as e:
            print(f"[!] storage probe failed for {key}: {e}")

    # Fallback: scan lw_documents by fuzzy filename match (handles vault-only
    # docs whose key uses a different naming scheme).
    try:
        target = re.sub(r'[\s\-_/\\]', '', base).lower()
        target = re.sub(r'\.pdf$', '', target)
        if target:
            docs = db.query(LandwiseDocument).all()
            for d in docs:
                fn_norm = re.sub(r'[\s\-_/\\]', '', d.original_filename or '').lower()
                fn_norm = re.sub(r'\.pdf$', '', fn_norm)
                if target in fn_norm:
                    if d.storage_key:
                        try:
                            if storage.exists(d.storage_key):
                                return RedirectResponse(url=storage.presigned_url(d.storage_key), status_code=302)
                        except Exception:
                            pass
                    if d.file_content:
                        return Response(
                            content=d.file_content,
                            media_type="application/pdf",
                            headers={"Content-Disposition": f"inline; filename={d.original_filename}"}
                        )
    except Exception as e:
        print(f"[!] Vault DB filename scan failed: {e}")

    print(f"[!] File not found: {file_path}  (tried keys: {candidates})")
    raise HTTPException(404, f"File not found: {file_path}")


@router.get("/documents/{document_id}")
def get_document(
    document_id: str,
    include_fields: bool = False,
    include_annotations: bool = False,
    db: Session = Depends(get_db)
):
    """EP #09: Get document metadata + extracted fields + annotations."""
    doc = db.query(LandwiseDocument).filter(LandwiseDocument.id == document_id).first()
    if not doc:
        # Compatibility with legacy doc_no identification
        doc = db.query(LandwiseDocument).filter(LandwiseDocument.original_filename.contains(document_id)).first()
        if not doc:
            raise HTTPException(404, "Document not found")

    result = {
        "id": doc.id, "parcel_id": doc.parcel_id,
        "document_type": doc.document_type, "source": doc.source,
        "original_filename": doc.original_filename,
        "storage_key": doc.storage_key,
        "mime_type": doc.mime_type,
        "file_size_bytes": doc.file_size_bytes,
        "language": doc.language,
        "year_from": doc.year_from, "year_to": doc.year_to,
        "extraction_status": doc.extraction_status,
        "extraction_confidence": float(doc.extraction_confidence) if doc.extraction_confidence else None,
    }

    if include_fields:
        fields = db.query(ExtractedField).filter(ExtractedField.document_id == document_id).all()
        result["extracted_fields"] = [{
            "id": f.id, "field_key": f.field_key,
            "raw_value": f.raw_value,
            "normalised_value": f.normalised_value,
            "confidence": float(f.confidence) if f.confidence else None,
            "is_overridden": f.is_overridden,
            "overridden_value": f.overridden_value,
            "page_number": f.page_number,
        } for f in fields]

    if include_annotations:
        anns = db.query(DocumentAnnotation).filter(
            DocumentAnnotation.document_id == document_id,
            DocumentAnnotation.deleted_at.is_(None)
        ).all()
        result["annotations"] = [{
            "id": a.id, "type": a.annotation_type,
            "text": a.selected_text, "note": a.note,
            "page": a.page_number, "box": a.bounding_box,
            "created_at": str(a.created_at),
        } for a in anns]

    return result

@router.post("/parcels/{parcel_id}/annotations", status_code=201)
def create_annotation(parcel_id: str, body: AnnotationCreate, db: Session = Depends(get_db)):
    """Create a DocumentAnnotation.

    The `document_id` from the client may be:
      - a UUID matching LandwiseDocument.id
      - a doc number like "5548_2013" or "5548/2013"
      - a filename like "5548_2013.pdf"
    We resolve all of these to a real lw_documents row, preferring
    candidates that belong to this parcel.
    """
    raw = (body.document_id or "").strip()
    candidates = {raw}
    # doc-no normalizations
    candidates.add(raw.replace("/", "_"))
    candidates.add(raw.replace("_", "/"))
    # strip .pdf extension if present
    if raw.lower().endswith(".pdf"):
        base = raw[:-4]
        candidates.update({base, base.replace("/", "_"), base.replace("_", "/")})
    candidates.discard("")

    doc = db.query(LandwiseDocument).filter(LandwiseDocument.id == raw).first()
    if not doc:
        # 1. Try parcel-scoped filename match for each candidate.
        for c in candidates:
            doc = (
                db.query(LandwiseDocument)
                .filter(
                    LandwiseDocument.parcel_id == parcel_id,
                    LandwiseDocument.deleted_at.is_(None),
                    LandwiseDocument.original_filename.contains(c),
                )
                .first()
            )
            if doc:
                break
        # 2. Fall back to a global filename match (legacy data).
        if not doc:
            for c in candidates:
                doc = (
                    db.query(LandwiseDocument)
                    .filter(LandwiseDocument.original_filename.contains(c))
                    .first()
                )
                if doc:
                    break
        if not doc:
            raise HTTPException(
                404,
                f"Document reference not found for '{raw}' on parcel {parcel_id}",
            )

    anno = DocumentAnnotation(
        id=gen_uuid(),
        document_id=doc.id,
        parcel_id=parcel_id,
        annotation_type=body.annotation_type,
        selected_text=body.selected_text,
        note=body.note,
        page_number=body.page_number,
        bounding_box=body.bounding_box
    )
    db.add(anno)
    db.commit()
    db.refresh(anno)
    return anno


@router.get("/parcels/by-request/{request_id}")
def get_parcel_by_request(request_id: str, db: Session = Depends(get_db)):
    """
    Resolve a parcel from an analysis request_id. The HierarchyPage uses this
    when it lands without a parcelId in the URL (e.g. arriving from /verify)
    so the Notes Cockpit can still query annotations for the parcel.
    """
    parcel = (
        db.query(Parcel)
        .filter(Parcel.last_analysis_request_id == request_id, Parcel.is_active == True)  # noqa: E712
        .first()
    )
    if not parcel:
        raise HTTPException(404, "No parcel registered for this request_id")
    return {
        "parcel_id": parcel.id,
        "survey_number": parcel.survey_number,
        "subdivision": parcel.subdivision,
        "project_id": parcel.project_id,
    }


@router.get("/parcels/{parcel_id}/annotations")
def list_parcel_annotations(parcel_id: str, db: Session = Depends(get_db)):
    """
    Flat list of every annotation for a parcel. Each row carries enough context
    (document filename + survey number + page) for the frontend to render a
    Notes Cockpit and to deep-link back to the source PDF + page + bbox.
    """
    parcel = db.query(Parcel).filter(Parcel.id == parcel_id).first()
    if not parcel:
        raise HTTPException(404, "Parcel not found")

    rows = (
        db.query(DocumentAnnotation, LandwiseDocument)
        .join(LandwiseDocument, DocumentAnnotation.document_id == LandwiseDocument.id)
        .filter(
            DocumentAnnotation.parcel_id == parcel_id,
            DocumentAnnotation.deleted_at.is_(None),
        )
        .order_by(desc(DocumentAnnotation.created_at))
        .all()
    )

    survey_number = f"{parcel.survey_number}{('/' + parcel.subdivision) if parcel.subdivision else ''}"

    data = [
        {
            "id": ann.id,
            "document_id": ann.document_id,
            "doc_no": doc.original_filename,
            "survey_number": survey_number,
            "annotation_type": ann.annotation_type,
            "selected_text": ann.selected_text,
            "note": ann.note,
            "page_number": ann.page_number,
            "bounding_box": ann.bounding_box,
            "is_resolved": bool(ann.is_resolved),
            "created_at": ann.created_at.isoformat() if ann.created_at else None,
        }
        for ann, doc in rows
    ]
    return {"data": data}


@router.get("/parcels/{parcel_id}/annotations/summary")
def parcel_annotations_summary(parcel_id: str, db: Session = Depends(get_db)):
    """
    Grouped summary used by the Notes Cockpit. Returns one bucket per document
    with its notes ordered by page, plus parcel-level totals so the UI can show
    a header like "Survey No 46 — 7 notes across 3 deeds".
    """
    parcel = db.query(Parcel).filter(Parcel.id == parcel_id).first()
    if not parcel:
        raise HTTPException(404, "Parcel not found")

    rows = (
        db.query(DocumentAnnotation, LandwiseDocument)
        .join(LandwiseDocument, DocumentAnnotation.document_id == LandwiseDocument.id)
        .filter(
            DocumentAnnotation.parcel_id == parcel_id,
            DocumentAnnotation.deleted_at.is_(None),
        )
        .order_by(LandwiseDocument.original_filename, DocumentAnnotation.page_number)
        .all()
    )

    survey_number = f"{parcel.survey_number}{('/' + parcel.subdivision) if parcel.subdivision else ''}"

    by_doc: dict = {}
    for ann, doc in rows:
        bucket = by_doc.setdefault(doc.id, {
            "document_id": doc.id,
            "doc_no": doc.original_filename,
            "document_type": doc.document_type,
            "notes": [],
        })
        bucket["notes"].append({
            "id": ann.id,
            "annotation_type": ann.annotation_type,
            "selected_text": ann.selected_text,
            "note": ann.note,
            "page_number": ann.page_number,
            "bounding_box": ann.bounding_box,
            "is_resolved": bool(ann.is_resolved),
            "created_at": ann.created_at.isoformat() if ann.created_at else None,
        })

    documents = list(by_doc.values())
    total = sum(len(d["notes"]) for d in documents)

    return {
        "survey_number": survey_number,
        "parcel_id": parcel_id,
        "total_notes": total,
        "documents_with_notes": len(documents),
        "documents": documents,
    }


@router.delete("/annotations/{annotation_id}", status_code=204)
def delete_annotation(annotation_id: str, db: Session = Depends(get_db)):
    """Soft-delete a single annotation so it stops appearing in the cockpit/PDF."""
    ann = db.query(DocumentAnnotation).filter(DocumentAnnotation.id == annotation_id).first()
    if not ann:
        raise HTTPException(404, "Annotation not found")
    ann.deleted_at = func.now()
    db.commit()
    return


# ══════════════════════════════════════════════════════════════
#  EP #10-14: CHECKLIST, RISKS, CONSISTENCY
# ══════════════════════════════════════════════════════════════

@router.get("/parcels/{parcel_id}/checklist")
def get_checklist(parcel_id: str, db: Session = Depends(get_db)):
    items = db.query(ChecklistItem).filter(ChecklistItem.parcel_id == parcel_id).order_by(ChecklistItem.id).all()
    return {"data": items}

@router.patch("/checklist/{item_id}")
def update_checklist_verdict(item_id: str, body: ChecklistVerdictUpdate, db: Session = Depends(get_db)):
    item = db.query(ChecklistItem).filter(ChecklistItem.id == item_id).first()
    if not item:
        raise HTTPException(404, "Checklist item not found")

    item.verdict = body.verdict
    item.lawyer_notes = body.lawyer_notes
    item.updated_at = func.now()
    db.commit()
    
    # Log audit
    AuditService.log(db, action="checklist.update", entity_type="checklist_item",
                     entity_id=item.id, parcel_id=item.parcel_id,
                     metadata={"verdict": body.verdict})
    
    return item

@router.get("/parcels/{parcel_id}/risks")
def get_risks(parcel_id: str, db: Session = Depends(get_db)):
    risks = db.query(RiskFlag).filter(RiskFlag.parcel_id == parcel_id).all()
    return {"data": risks}

@router.patch("/risks/{risk_id}/action")
def action_risk(risk_id: str, body: RiskFlagAction, db: Session = Depends(get_db)):
    risk = db.query(RiskFlag).filter(RiskFlag.id == risk_id).first()
    if not risk:
        raise HTTPException(404, "Risk flag not found")

    risk.status = body.action
    risk.action_note = body.action_note
    risk.updated_at = func.now()
    db.commit()
    return risk


# ══════════════════════════════════════════════════════════════
#  EP #15-18: HIERARCHY, ANALYZE, OPINION
# ══════════════════════════════════════════════════════════════

@router.get("/parcels/{parcel_id}/hierarchy")
async def get_hierarchy(parcel_id: str, db: Session = Depends(get_db)):
    """EP #15: Get the full property hierarchy tree."""
    from api.validate.handler import handle_get_global_hierarchy
    
    # Fallback to persistent request_id from parcel table
    parcel = db.query(Parcel).filter(Parcel.id == parcel_id, Parcel.is_active == True).first()
    request_id = parcel.last_analysis_request_id if parcel else None
    
    # This calls the validate handler which returns the JSON
    if not request_id:
        raise HTTPException(404, "No analysis data found for this parcel")
        
    return await handle_get_global_hierarchy(request_id)

@router.post("/parcels/{parcel_id}/analyze")
async def analyze_parcel(request: Request, parcel_id: str, limit: Optional[int] = None, db: Session = Depends(get_db)):
    """EP: Trigger the full Legal Advisor Analysis."""
    parcel = db.query(Parcel).filter(Parcel.id == parcel_id, Parcel.is_active == True).first()
    if not parcel:
        raise HTTPException(404, "Parcel not found or has been deleted")

    # Invalidate the cached risk-score result so the next /get-risk-score
    # call recomputes against the fresh audit data instead of returning
    # the previous run's cached LLM summary.
    # We also delete the on-disk risk_score.json fallback so the two caches
    # cannot disagree — otherwise /get-risk-score's file-fallback path will
    # serve the previous run's score after the DB row has been cleared.
    parcel.risk_score_data = None
    parcel.risk_score_computed_at = None
    db.commit()
    # The risk_score.json cache for the previous run lived on local disk —
    # nothing local persists anymore, so this is now a no-op. The S3 copy
    # under outputs/validate/<rid>/risk_score.json stays until the parcel
    # is re-analyzed (the next run rewrites the same key).

    # Identify Input Documents
    docs = db.query(LandwiseDocument).filter(
        LandwiseDocument.parcel_id == parcel_id,
        LandwiseDocument.deleted_at.is_(None)
    ).all()

    ec_doc = next((d for d in docs if d.document_type and d.document_type.upper().replace(' ', '_') in ['ENCUMBRANCE_CERTIFICATE', 'EC']), None)
    if not ec_doc:
        doc_types = [f"{d.original_filename} ({d.document_type})" for d in docs]
        raise HTTPException(
            status_code=400, 
            detail=f"No Encumbrance Certificate (EC) found for this parcel. Documents found: {', '.join(doc_types) if doc_types else 'None'}. Please upload an EC and set its type correctly."
        )

    deed_docs = [d for d in docs if d.document_type and d.document_type.upper().replace(' ', '_') in ['SALE_DEED', 'PARENT_DOCUMENT', 'SALE DEED']]
    has_deeds = len(deed_docs) > 0

    # Prepare a tmp directory mirror of the documents for the pipeline.
    # storage_key is now an S3 key — resolve via storage abstraction so we
    # work whether the bytes are on local disk, in DB.file_content, or in S3.
    from common.storage import get_storage
    storage = get_storage()
    temp_dir = tempfile.mkdtemp(prefix="analyze_deeds_")
    ec_local_path = None
    try:
        def _materialize(d) -> Optional[str]:
            """Return a local path for a LandwiseDocument, materializing
            from S3 or DB bytes as needed. None on failure."""
            target_name = d.original_filename or os.path.basename(d.storage_key or "doc.bin")
            target = os.path.join(temp_dir, target_name)
            # 1) Already on local disk (legacy).
            if d.storage_key and os.path.isabs(d.storage_key) and os.path.exists(d.storage_key):
                shutil.copy2(d.storage_key, target)
                return target
            # 2) Storage backend (S3) holds it under storage_key.
            try:
                if d.storage_key and storage.exists(d.storage_key):
                    storage.download_to(d.storage_key, target)
                    return target
            except Exception as e:
                print(f"[!] storage.download_to failed for {d.storage_key}: {e}")
            # 3) Last resort: DB-stored bytes.
            if d.file_content:
                with open(target, "wb") as f:
                    f.write(d.file_content)
                return target
            print(f"[!] Could not materialize document {d.id} ({d.original_filename})")
            return None

        # Materialize EC
        ec_local_path = _materialize(ec_doc)
        if not ec_local_path:
            raise HTTPException(
                status_code=500,
                detail=f"Failed to materialize EC document {ec_doc.id} for analysis",
            )

        # Materialize deeds (PDFs + extract any ZIPs into temp_dir)
        for d in deed_docs:
            mat = _materialize(d)
            if not mat:
                continue
            if mat.lower().endswith(".zip"):
                try:
                    with zipfile.ZipFile(mat, "r") as z:
                        z.extractall(temp_dir)
                except Exception as e:
                    print(f"[!] ZIP extract failed for {mat}: {e}")

        result = await handle_validate(
            request=request,
            type="local_path",
            ec_pdf_path=ec_local_path,
            registration_docs_dir=temp_dir,
            visual_debug=True,
            transaction_limit=limit,
            parcel_id=parcel_id
        )

        parcel.last_analysis_request_id = result.get("request_id")
        db.commit()
        return result

    finally:
        if temp_dir and os.path.exists(temp_dir):
            shutil.rmtree(temp_dir, ignore_errors=True)

@router.get("/parcels/{parcel_id}/opinion")
def get_opinion(parcel_id: str, db: Session = Depends(get_db)):
    opinion = db.query(LegalOpinion).filter(LegalOpinion.parcel_id == parcel_id).first()
    if not opinion:
        return {
            "status": "not_started",
            "message": "No legal opinion draft found for this parcel",
            "id": None,
            "sections": []
        }
    
    sections = db.query(OpinionSection).filter(OpinionSection.opinion_id == opinion.id).order_by(OpinionSection.section_order).all()
    
    # Derive markdown path from pdf_storage_key if available
    report_md_content = None
    if opinion.pdf_storage_key:
        md_path = opinion.pdf_storage_key.replace(".pdf", ".md")
        # The stored path is relative to Server dir (e.g. outputs/validate/.../legal/...)
        full_md_path = os.path.join(os.path.dirname(__file__), "..", md_path)
        full_md_path = os.path.normpath(full_md_path)
        if os.path.exists(full_md_path):
            try:
                with open(full_md_path, 'r', encoding='utf-8') as f:
                    report_md_content = f.read()
            except Exception:
                pass
    
    return {
        "id": opinion.id,
        "status": opinion.status,
        "verdict": opinion.verdict,
        "report_storage_key": opinion.pdf_storage_key,
        "report_md_content": report_md_content,
        "is_locked": opinion.is_locked,
        "sections": [{
            "id": s.id, "type": s.section_type,
            "ai_draft": s.ai_draft_content, "final_content": s.final_content,
            "is_accepted": s.is_accepted, "order": s.section_order
        } for s in sections],
        "signed_at": str(opinion.signed_at) if opinion.signed_at else None
    }

@router.post("/parcels/{parcel_id}/opinion")
def initialize_opinion_draft(parcel_id: str, db: Session = Depends(get_db)):
    """EP #16: Bootstrap the Legal Opinion structure using AI analysis."""
    parcel = db.query(Parcel).filter(Parcel.id == parcel_id, Parcel.is_active == True).first()
    if not parcel:
        raise HTTPException(404, "Parcel not found or has been deleted")

    # Workflow Gate check
    unlocked, message = GatekeeperService.is_opinion_unlocked(db, parcel_id)
    if not unlocked:
        raise HTTPException(403, detail=message)
        
    existing = db.query(LegalOpinion).filter(LegalOpinion.parcel_id == parcel_id).first()
    if existing:
        return {"id": existing.id, "status": "already_exists"}

    opinion = LegalOpinion(id=gen_uuid(), parcel_id=parcel_id, status="draft")
    db.add(opinion)
    db.commit()
    
    # Add the 7 legal opinion sections
    sections = [
        ("possession_revenue", "POSSESSION & REVENUE RECORDS: Analysis of current possession status, Patta, Chitta, and revenue records.", 1),
        ("land_nature", "NATURE OF LAND AND DESCRIPTION: Classification (Wet/Dry), land use, and physical description.", 2),
        ("tn_land_reforms", "CLARIFICATIONS UNDER TN LAND REFORMS LAWS: Ceiling limits, tenancy, assigned lands, and Schedule VI/VII status.", 3),
        ("title_flow_ec", "TITLE FLOW & ENCUMBRANCES (EC ANALYSIS): Chain of title from EC records and encumbrance status.", 4),
        ("legal_protections", "SPECIFIC LEGAL PROTECTIONS: Alienation restrictions, UDR Act applicability, and special statutes.", 5),
        ("acquisitions_notices", "ACQUISITIONS & NOTICES: Land acquisition status, government notices, and court attachments.", 6),
        ("lis_pendens", "LIS PENDENS & CIVIL SUITS: Pending litigation, civil suits, and court case status.", 7),
        ("documents_checklist", "DOCUMENTS CHECKLIST & DISCREPANCIES: Verification of documents and noted discrepancies.", 8),
        ("final_verdict", "FINAL VERDICT & LEGAL OPINION: Overall legal opinion, risk assessment, and recommendations.", 9)
    ]
    for section_type, content, order in sections:
        db.add(OpinionSection(
            id=gen_uuid(),
            opinion_id=opinion.id,
            section_type=section_type,
            ai_draft_content=content,
            section_order=order,
            final_content=''
        ))

    db.commit()

    # If the LLM report already exists on disk for the parcel's analysis, seed
    # rich content into the freshly-created sections so the user sees the full
    # write-up immediately on first load instead of generic stubs.
    try:
        seeded = _try_seed_sections_from_disk(db, parcel)
        if seeded:
            print(f"[*] Seeded {seeded} OpinionSection rows from existing report for parcel {parcel_id}")
            # Also expose the report URL on the opinion record
            md_dir = os.path.join("outputs", "validate", parcel.last_analysis_request_id, "legal")
            pdf_path = os.path.join(md_dir, "legal_opinion_report.pdf")
            if os.path.exists(pdf_path):
                opinion.pdf_storage_key = f"outputs/validate/{parcel.last_analysis_request_id}/legal/legal_opinion_report.pdf"
                db.commit()
    except Exception as e:
        print(f"[!] Initialize: seed-from-disk failed: {e}")

    db.refresh(opinion)
    return opinion

@router.patch("/opinion-sections/{section_id}")
def update_section(section_id: str, body: OpinionSectionUpdate, db: Session = Depends(get_db)):
    section = db.query(OpinionSection).filter(OpinionSection.id == section_id).first()
    if not section:
        raise HTTPException(404, "Section not found")
        
    # Check if opinion is locked
    opinion = db.query(LegalOpinion).filter(LegalOpinion.id == section.opinion_id).first()
    if GatekeeperService.is_opinion_locked(opinion):
        raise HTTPException(403, "Legal opinion is signed and locked.")

    section.final_content = body.final_content
    section.is_accepted = body.is_accepted
    db.commit()
    return section


# ══════════════════════════════════════════════════════════════
#  EXTRA FORENSIC ENDPOINTS
# ══════════════════════════════════════════════════════════════

# ── Helpers: persist parsed report sections into OpinionSection rows ────────

# Map markdown section number → DB section_type
_REPORT_NUMBER_TO_TYPE = {
    "1": "possession_revenue",
    "2": "land_nature",
    "3": "tn_land_reforms",
    "4": "title_flow_ec",
    "5": "legal_protections",
    "6": "acquisitions_notices",
    "7": "lis_pendens",
    "8": "documents_checklist",
    "F": "final_verdict",
    "9": "final_verdict",
}


def _format_section_as_markdown(section: dict) -> str:
    """Render a parsed report section dict as a single markdown string suitable
    for storage in OpinionSection.ai_draft_content and rendering via ReactMarkdown
    in the frontend."""
    parts: list = []
    subs = section.get("subtitles") or []
    if subs:
        for sub in subs:
            letter = (sub.get("letter") or "").strip()
            title = (sub.get("title") or "").strip()
            body = (sub.get("content") or "").strip()
            heading = f"**{letter}. {title}**" if letter else f"**{title}**"
            parts.append(heading)
            if body:
                parts.append(body)
            parts.append("")  # blank line separator
    body = (section.get("content") or "").strip()
    if body:
        parts.append(body)
    return "\n".join(parts).strip()


def _persist_report_sections_to_db(db: Session, parcel_id: str, parsed_sections: list) -> int:
    """Write each parsed section's rich markdown into the matching OpinionSection
    row's ai_draft_content. Returns count of sections updated."""
    opinion = db.query(LegalOpinion).filter(LegalOpinion.parcel_id == parcel_id).first()
    if not opinion:
        return 0

    # Build lookup by section_type → rich markdown body
    by_type: dict = {}
    for sec in parsed_sections or []:
        t = _REPORT_NUMBER_TO_TYPE.get(str(sec.get("number")))
        if not t:
            continue
        md = _format_section_as_markdown(sec)
        if md:
            by_type[t] = md

    if not by_type:
        return 0

    rows = db.query(OpinionSection).filter(OpinionSection.opinion_id == opinion.id).all()
    updated = 0
    for row in rows:
        rich = by_type.get(row.section_type)
        if rich:
            row.ai_draft_content = rich
            updated += 1
    db.commit()
    return updated


def _try_seed_sections_from_disk(db: Session, parcel: "Parcel") -> int:
    """If the markdown report exists on disk for the parcel's last analysis,
    parse it and persist the rich content into OpinionSection rows. Used at
    Initialize time so the user sees rich content without an extra Generate."""
    if not parcel.last_analysis_request_id:
        return 0
    md_path = os.path.join(
        "outputs", "validate", parcel.last_analysis_request_id,
        "legal", "legal_opinion_report.md"
    )
    if not os.path.exists(md_path):
        return 0
    try:
        with open(md_path, "r", encoding="utf-8") as f:
            content = f.read()
        from api.validate.handler import parse_report_sections
        parsed = parse_report_sections(content)
        return _persist_report_sections_to_db(db, parcel.id, parsed)
    except Exception as e:
        print(f"[!] Seed sections from disk failed: {e}")
        return 0


@router.post("/parcels/{parcel_id}/report")
async def generate_legal_report(parcel_id: str, db: Session = Depends(get_db)):
    """Generate and return the AI Legal Opinion Report.

    Side-effects:
      - Writes legal_opinion_report.md / .pdf to disk
      - Updates LegalOpinion.pdf_storage_key
      - Persists the parsed rich content into each OpinionSection.ai_draft_content
        so subsequent GETs of /opinion return the full content without re-parsing.
    """
    parcel = db.query(Parcel).filter(Parcel.id == parcel_id, Parcel.is_active == True).first()
    if not parcel or not parcel.last_analysis_request_id:
        raise HTTPException(404, "Audit data not found or parcel has been deleted. Run analysis first.")

    from api.validate.handler import handle_generate_report
    report_data = await handle_generate_report(parcel.last_analysis_request_id)

    if report_data.get("status") == "success":
        opinion = db.query(LegalOpinion).filter(LegalOpinion.parcel_id == parcel_id).first()
        if opinion:
            opinion.pdf_storage_key = report_data.get("report_url")
            db.commit()
        # Persist the rich parsed content into OpinionSection rows
        try:
            updated = _persist_report_sections_to_db(db, parcel_id, report_data.get("sections") or [])
            print(f"[*] Persisted rich content into {updated} OpinionSection rows for parcel {parcel_id}")
        except Exception as e:
            print(f"[!] Failed to persist parsed sections: {e}")

    return report_data


@router.get("/parcels/{parcel_id}/ownership")
async def get_survey_ownership(parcel_id: str, db: Session = Depends(get_db)):
    """Get consolidated survey ownership summary."""
    parcel = db.query(Parcel).filter(Parcel.id == parcel_id, Parcel.is_active == True).first()
    if not parcel or not parcel.last_analysis_request_id:
        raise HTTPException(404, "Audit data not found or parcel has been deleted. Run analysis first.")
    
    from api.validate.handler import handle_get_survey_ownership
    return await handle_get_survey_ownership(parcel.last_analysis_request_id)


@router.get("/parcels/{parcel_id}/report-sections")
def get_report_sections(parcel_id: str, db: Session = Depends(get_db)):
    """Get parsed report sections with subtitles for a parcel.
    
    This endpoint reads directly from the file system using the parcel's
    last_analysis_request_id, so it works even if opinion data was wiped.
    """
    import logging
    logger = logging.getLogger(__name__)
    
    parcel = db.query(Parcel).filter(Parcel.id == parcel_id, Parcel.is_active == True).first()
    if not parcel:
        logger.warning(f"[Report Sections] Parcel not found: {parcel_id}")
        raise HTTPException(404, "Parcel not found")
    
    # Get request_id from parcel - this is how we locate the report files
    request_id = parcel.last_analysis_request_id
    if not request_id:
        logger.warning(f"[Report Sections] No analysis request_id for parcel: {parcel_id}")
        raise HTTPException(404, "No analysis data found for this parcel")
    
    # Try to find the markdown file directly from the file system.
    # __file__ is Server/api/landwise/router.py — so we need TWO `..` to reach
    # the Server/ root where the outputs/ folder lives.
    server_root = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", ".."))
    md_path = os.path.join("outputs", "validate", request_id, "legal", "legal_opinion_report.md")
    full_md_path = os.path.normpath(os.path.join(server_root, md_path))

    # Also probe the cwd-relative path (matches how the rest of the server
    # writes files via relative `outputs/...` paths).
    cwd_path = os.path.normpath(md_path)

    logger.info(f"[Report Sections] Looking for file at: {full_md_path}  OR  {cwd_path}")

    chosen_path = None
    for candidate in (full_md_path, cwd_path):
        if os.path.exists(candidate):
            chosen_path = candidate
            break

    if not chosen_path:
        # Also try to find via opinion record if it exists
        opinion = db.query(LegalOpinion).filter(LegalOpinion.parcel_id == parcel_id).first()
        if opinion and opinion.pdf_storage_key:
            md_rel = opinion.pdf_storage_key.replace(".pdf", ".md")
            for candidate in (
                os.path.normpath(os.path.join(server_root, md_rel)),
                os.path.normpath(md_rel),
            ):
                if os.path.exists(candidate):
                    chosen_path = candidate
                    logger.info(f"[Report Sections] Found via opinion record: {chosen_path}")
                    break

        if not chosen_path:
            logger.error(f"[Report Sections] Report file not found at: {full_md_path}")
            raise HTTPException(404, f"Report file not found. Generate the report first.")

    full_md_path = chosen_path
    
    try:
        with open(full_md_path, 'r', encoding='utf-8') as f:
            content = f.read()
    except Exception as e:
        logger.error(f"[Report Sections] Error reading file: {e}")
        raise HTTPException(500, f"Error reading report file: {str(e)}")
    
    from api.validate.handler import parse_report_sections
    sections = parse_report_sections(content)
    
    logger.info(f"[Report Sections] Successfully parsed {len(sections)} sections for parcel {parcel_id}")
    
    return {
        "status": "success",
        "parcel_id": parcel_id,
        "survey_number": parcel.survey_number,
        "request_id": request_id,
        "file_path": full_md_path,
        "sections": sections
    }


# ══════════════════════════════════════════════════════════════
#  ADDITIONAL SYSTEM ENDPOINTS
# ══════════════════════════════════════════════════════════════

@router.get("/extraction-jobs/{job_id}")
def get_extraction_job(job_id: str, db: Session = Depends(get_db)):
    job = db.query(ExtractionJob).filter(ExtractionJob.id == job_id).first()
    if not job:
        raise HTTPException(404, "Extraction job not found")
    return job

@router.get("/documents/{document_id}/fields")
def list_document_fields(document_id: str, db: Session = Depends(get_db)):
    fields = db.query(ExtractedField).filter(ExtractedField.document_id == document_id).all()
    return {"data": fields}

@router.patch("/fields/{field_id}")
def override_field(field_id: str, body: FieldOverride, db: Session = Depends(get_db)):
    field = db.query(ExtractedField).filter(ExtractedField.id == field_id).first()
    if not field:
        raise HTTPException(404, "Field on found")
    field.overridden_value = body.overridden_value
    field.is_overridden = True
    db.commit()
    return field

@router.get("/parcels/{parcel_id}/audit")
def list_audit_logs(parcel_id: str, db: Session = Depends(get_db)):
    logs = db.query(AuditLog).filter(AuditLog.parcel_id == parcel_id).order_by(desc(AuditLog.created_at)).all()
    return {"data": logs}

@router.get("/parcels/{parcel_id}/timeline")
def get_parcel_timeline(parcel_id: str, db: Session = Depends(get_db)):
    """EP: Get historical timeline data for property ownership and encumbrances."""
    # This combines ownership transfers and encumbrances into a single stream
    owners = db.query(OwnershipTransfer).filter(OwnershipTransfer.parcel_id == parcel_id).all()
    encs = db.query(Encumbrance).filter(Encumbrance.parcel_id == parcel_id).all()
    
    events = []
    for o in owners:
        events.append({
            "id": o.id,
            "date": str(o.registration_date or o.transfer_date or ""),
            "type": "ownership_transfer",
            "title": f"Transfer ({o.transfer_type or 'sale'})",
            "desc": f"Consideration: ₹{o.consideration_amount}" if o.consideration_amount else "",
            "doc_no": o.registration_number,
        })
    for e in encs:
        events.append({
            "id": e.id,
            "date": str(e.created_date or ""),
            "type": "encumbrance",
            "title": f"Encumbrance: {e.encumbrance_type}",
            "desc": f"Value: ₹{e.amount} (Holder: {e.holder_name})" if e.amount else f"Holder: {e.holder_name}",
            "doc_no": None,
        })
        
    events.sort(key=lambda x: x["date"], reverse=True)
    return {"data": events}

@router.get("/parcels/{parcel_id}/stats")
def get_parcel_stats(parcel_id: str, db: Session = Depends(get_db)):
    """EP: Get real-time parcel statistics, risk score, and workflow status."""
    parcel = db.query(Parcel).filter(Parcel.id == parcel_id, Parcel.is_active == True).first()
    if not parcel:
        raise HTTPException(404, "Parcel not found or has been deleted")
    
    # Get documents for this parcel
    documents = db.query(LandwiseDocument).filter(
        LandwiseDocument.parcel_id == parcel_id,
        LandwiseDocument.deleted_at.is_(None)
    ).all()
    
    # Get encumbrances for chain length calculation
    encumbrances = db.query(Encumbrance).filter(Encumbrance.parcel_id == parcel_id).all()
    ownership_transfers = db.query(OwnershipTransfer).filter(OwnershipTransfer.parcel_id == parcel_id).all()
    
    # Get risk flags
    risk_flags = db.query(RiskFlag).filter(RiskFlag.parcel_id == parcel_id).all()
    
    # Get checklist items
    checklist_items = db.query(ChecklistItem).filter(ChecklistItem.parcel_id == parcel_id).all()
    
    # Get analysis results for workflow status
    from common.landwise_models import AnalysisResult
    analysis_results = db.query(AnalysisResult).filter(
        AnalysisResult.parcel_id == parcel_id
    ).all()
    
    # Check for specific result types
    hierarchy_result = next((r for r in analysis_results if r.result_type == 'hierarchy_tree'), None)
    validation_result = next((r for r in analysis_results if r.result_type == 'validation_results'), None)
    risk_analysis_result = next((r for r in analysis_results if r.result_type == 'risk_analysis'), None)
    
    # Calculate document stats
    doc_count = len(documents)
    # Case-insensitive matching for document types
    ec_docs = [d for d in documents if d.document_type and d.document_type.upper().replace(' ', '_') in ['ENCUMBRANCE_CERTIFICATE', 'EC']]
    sale_deed_docs = [d for d in documents if d.document_type and d.document_type.upper().replace(' ', '_') in ['SALE_DEED', 'SALE_DEED']]
    has_ec = len(ec_docs) > 0
    has_deeds = len(sale_deed_docs) > 0
    extracted_docs = [d for d in documents if d.extraction_status == 'completed']

    # Helper: locate the analysis output dir for this parcel's last_analysis_request_id
    request_id = parcel.last_analysis_request_id
    output_dir = os.path.join('outputs', 'validate', request_id) if request_id else None
    hierarchy_json_exists = bool(output_dir and os.path.exists(os.path.join(output_dir, 'hierarchy_tree.json')))
    risk_json_exists = bool(output_dir and os.path.exists(os.path.join(output_dir, 'risk_score.json')))
    ec_json_exists = bool(output_dir and os.path.exists(os.path.join(output_dir, 'ec_final.json')))
    legal_md_exists = bool(output_dir and os.path.exists(os.path.join(output_dir, 'legal', 'legal_opinion_report.md')))

    # Calculate chain length — prefer ownership_transfers, fall back to EC date range
    chain_years = 0
    if ownership_transfers:
        dates = [o.transfer_date for o in ownership_transfers if o.transfer_date]
        if dates:
            earliest = min(dates)
            latest = max(dates)
            chain_years = (latest - earliest).days // 365 if earliest and latest else 0

    if chain_years == 0 and ec_json_exists:
        try:
            from datetime import datetime
            with open(os.path.join(output_dir, 'ec_final.json'), encoding='utf-8') as f:
                ec_data = json.load(f)
            parsed_dates = []
            for entry in ec_data:
                raw = entry.get('date') or entry.get('registration_date')
                if not raw:
                    continue
                # Common LLM formats: "01-Jul-1975", "21-May-1990", "27-Nov-2014"
                for fmt in ('%d-%b-%Y', '%d/%m/%Y', '%Y-%m-%d', '%d-%m-%Y'):
                    try:
                        parsed_dates.append(datetime.strptime(str(raw).strip(), fmt))
                        break
                    except Exception:
                        continue
            if parsed_dates:
                earliest = min(parsed_dates)
                latest = max(parsed_dates)
                chain_years = (latest - earliest).days // 365
        except Exception as e:
            print(f"[!] EC date parse for chain length failed: {e}")

    # Active encumbrances = encumbrances tied to THIS parcel's survey number.
    # Per product spec: a parcel for a single survey number has at most one EC,
    # so the encumbrance count for this card = number of EC documents for this
    # parcel (1 if uploaded, 0 otherwise). DB-stored Encumbrance rows still take
    # precedence if any exist.
    active_encumbrances = len([e for e in encumbrances if (e.status or 'active') == 'active'])
    if active_encumbrances == 0:
        active_encumbrances = len(ec_docs)
    
    # Calculate risk score (0-100, higher is better/safer)
    risk_score = 0
    risk_status = "PENDING"
    risk_color = "slate"
    risk_factors = []
    
    # Try to get the latest risk score from the database (RiskScore model)
    from common.models import RiskScore
    latest_risk = db.query(RiskScore).filter(RiskScore.request_id == parcel.last_analysis_request_id).first()
    
    # If not in DB but hierarchy exists, trigger the computation (and storage)
    if not latest_risk and hierarchy_result and parcel.last_analysis_request_id:
        try:
            from api.validate.risk_score_engine import handle_get_risk_score
            import asyncio
            # Since this is a sync endpoint, we run the async handler
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            result_wrapper = loop.run_until_complete(handle_get_risk_score(parcel.last_analysis_request_id))
            loop.close()
            
            if result_wrapper.get("status") == "success":
                # Re-fetch the risk score object after it has been persisted to DB by handle_get_risk_score
                latest_risk = db.query(RiskScore).filter(RiskScore.request_id == parcel.last_analysis_request_id).first()
        except Exception as e:
            print(f"[!] Auto-calculating risk score failed: {e}")

    if latest_risk:
        risk_score = latest_risk.score
        grade = latest_risk.grade
        risk_factors = latest_risk.factors
        
        # Determine status/color based on grade
        if grade == "A":
            risk_status = "EXCELLENT"
            risk_color = "emerald"
        elif grade == "B":
            risk_status = "GOOD"
            risk_color = "blue"
        elif grade == "C":
            risk_status = "MODERATE"
            risk_color = "amber"
        elif grade == "D":
            risk_status = "HIGH RISK"
            risk_color = "orange"
        else:
            risk_status = "CRITICAL"
            risk_color = "red"
    elif hierarchy_result:
        # Hierarchy generated but risk score not yet computed/persisted
        risk_status = "COMPUTING"
        risk_color = "indigo"
    
    # Workflow Phases
    # A phase is "Complete" if the analysis pipeline produced its artifact —
    # either persisted in the DB OR present on disk under the request's output dir.
    workflow_phases = []

    # Has the analysis pipeline run for this parcel? (Audit produced an analysis dir)
    audit_ran = bool(request_id and output_dir and os.path.isdir(output_dir))

    # Phase 1: Document Ingestion — vault has any docs (EC + deeds, or any uploads + audit ran)
    if (has_ec and has_deeds) or (audit_ran and doc_count > 0):
        workflow_phases.append({
            "num": 1, "label": "Document Ingestion",
            "status": "Complete", "state": "completed"
        })
    elif has_ec or has_deeds or doc_count > 0:
        workflow_phases.append({
            "num": 1, "label": "Document Ingestion",
            "status": "In Progress", "state": "in_progress"
        })
    else:
        workflow_phases.append({
            "num": 1, "label": "Document Ingestion",
            "status": "Pending", "state": "pending"
        })

    # Phase 2: Data Extraction & NER — extraction flagged on docs, OR validation results exist
    has_validation_outputs = bool(output_dir and os.path.exists(os.path.join(output_dir, 'final_result.json')))
    if extracted_docs or has_validation_outputs or ec_json_exists:
        workflow_phases.append({
            "num": 2, "label": "Data Extraction & NER",
            "status": "Complete", "state": "completed"
        })
    elif documents or audit_ran:
        workflow_phases.append({
            "num": 2, "label": "Data Extraction & NER",
            "status": "In Progress", "state": "in_progress"
        })
    else:
        workflow_phases.append({
            "num": 2, "label": "Data Extraction & NER",
            "status": "Pending", "state": "pending"
        })

    # Phase 3: Chain Verification — hierarchy persisted to DB OR hierarchy_tree.json on disk
    if hierarchy_result or hierarchy_json_exists:
        workflow_phases.append({
            "num": 3, "label": "Chain Verification",
            "status": "Complete", "state": "completed"
        })
    elif ownership_transfers or audit_ran:
        workflow_phases.append({
            "num": 3, "label": "Chain Verification",
            "status": "In Progress", "state": "in_progress"
        })
    else:
        workflow_phases.append({
            "num": 3, "label": "Chain Verification",
            "status": "Not Started", "state": "not_started"
        })

    # Phase 4: Risk Analysis — RiskScore in DB, AnalysisResult, or risk_score.json on disk
    if risk_analysis_result or latest_risk or risk_json_exists:
        workflow_phases.append({
            "num": 4, "label": "Risk Analysis",
            "status": "Complete", "state": "completed"
        })
    elif hierarchy_result or hierarchy_json_exists:
        workflow_phases.append({
            "num": 4, "label": "Risk Analysis",
            "status": "In Progress", "state": "in_progress"
        })
    else:
        workflow_phases.append({
            "num": 4, "label": "Risk Analysis",
            "status": "Not Started", "state": "not_started"
        })

    # Phase 5: Opinion Draft — signed > drafted > md exists on disk > locked
    opinion = db.query(LegalOpinion).filter(LegalOpinion.parcel_id == parcel_id).first()
    if opinion and opinion.signed_at:
        workflow_phases.append({
            "num": 5, "label": "Opinion Draft",
            "status": "Complete", "state": "completed"
        })
    elif opinion or legal_md_exists:
        workflow_phases.append({
            "num": 5, "label": "Opinion Draft",
            "status": "In Progress", "state": "in_progress"
        })
    else:
        workflow_phases.append({
            "num": 5, "label": "Opinion Draft",
            "status": "Locked", "state": "locked"
        })
    
    return {
        "stats": {
            "risk_score": risk_score,
            "risk_status": risk_status,
            "risk_color": f"text-{risk_color}-600",
            "risk_factors": risk_factors,
            # Full vault count — surfaces pending docs (e.g. 277) rather than the
            # smaller "validated this audit" count (e.g. 20). The frontend computes
            # pending = document_count - audited_docs_count.
            "document_count": doc_count or (parcel.total_docs_count or 0),
            "audited_docs_count": parcel.total_docs_count or 0,
            "passed_docs": parcel.passed_docs_count or 0,
            "avg_trust": float(parcel.avg_trustability_score or 0),
            "scrutiny_doc_count": parcel.scrutiny_docs_count or 0,
            "last_analysis_request_id": parcel.last_analysis_request_id,
            "chain_length_years": chain_years,
            "active_encumbrances": active_encumbrances,
            "ec_uploaded": has_ec,
            "deeds_uploaded": has_deeds,
            "extraction_complete": len(extracted_docs) > 0 or has_validation_outputs or ec_json_exists,
            "risk_flags_count": len(risk_flags),
            # Workflow flags for frontend (mirror the workflow_phases logic)
            "document_ingestion_status": "completed" if ((has_ec and has_deeds) or (audit_ran and doc_count > 0)) else ("in_progress" if (has_ec or has_deeds or doc_count > 0) else "not_started"),
            "data_extraction_status": "completed" if (extracted_docs or has_validation_outputs or ec_json_exists) else ("in_progress" if (documents or audit_ran) else "not_started"),
            "chain_verification_status": "completed" if (hierarchy_result or hierarchy_json_exists) else ("in_progress" if (ownership_transfers or audit_ran) else "not_started"),
            "risk_analysis_status": "completed" if (risk_analysis_result or latest_risk or risk_json_exists) else ("in_progress" if (hierarchy_result or hierarchy_json_exists) else "not_started"),
            "opinion_draft_status": "completed" if (opinion and opinion.signed_at) else ("in_progress" if (opinion or legal_md_exists) else "not_started")
        },
        "workflow": workflow_phases
    }

@router.delete("/parcels/{parcel_id}")
def delete_parcel(parcel_id: str, db: Session = Depends(get_db)):
    """EP: Soft delete a parcel - marks as inactive but keeps all data and files intact.
    
    This allows the survey to be hidden from users while preserving:
    - All database records (ownership, encumbrances, documents, etc.)
    - PDF files in storage
    - Analysis results and validation data
    
    The data remains in DB but won't be visible in listings or interfere with new processing.
    """
    from datetime import datetime
    
    parcel = db.query(Parcel).filter(Parcel.id == parcel_id).first()
    if not parcel:
        raise HTTPException(404, "Parcel not found")
    
    # Check if already deleted
    if not parcel.is_active or parcel.deleted_at:
        raise HTTPException(400, "Parcel is already deleted")
    
    try:
        # Soft delete: mark as inactive and set deleted timestamp
        parcel.is_active = False
        parcel.deleted_at = datetime.now()
        parcel.status = "deleted"  # Also update status for clarity
        
        db.commit()
        
        return {
            "status": "success", 
            "message": f"Survey '{parcel.survey_number}' has been archived (soft deleted). All data and PDFs are preserved but hidden from view.",
            "parcel_id": parcel_id,
            "survey_number": parcel.survey_number,
            "deleted_at": parcel.deleted_at.isoformat() if parcel.deleted_at else None
        }
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/parcels/{parcel_id}/restore")
def restore_parcel(parcel_id: str, db: Session = Depends(get_db)):
    """EP: Restore a soft-deleted parcel - makes it visible again to users."""
    parcel = db.query(Parcel).filter(Parcel.id == parcel_id).first()
    if not parcel:
        raise HTTPException(404, "Parcel not found")
    
    # Check if already active
    if parcel.is_active and not parcel.deleted_at:
        raise HTTPException(400, "Parcel is already active")
    
    try:
        # Restore: mark as active and clear deleted timestamp
        parcel.is_active = True
        parcel.deleted_at = None
        parcel.status = "pending"  # Reset to pending or keep previous status?
        
        db.commit()
        
        return {
            "status": "success", 
            "message": f"Survey '{parcel.survey_number}' has been restored and is now visible.",
            "parcel_id": parcel_id,
            "survey_number": parcel.survey_number
        }
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/notifications")
def list_notifications(user_id: str = Query(...), db: Session = Depends(get_db)):
    notes = db.query(Notification).filter(Notification.user_id == user_id).order_by(desc(Notification.created_at)).all()
    return {"data": notes}

@router.post("/notifications/{notification_id}/read")
def mark_notification_read(notification_id: str, db: Session = Depends(get_db)):
    note = db.query(Notification).filter(Notification.id == notification_id).first()
    if not note:
        raise HTTPException(404, "Notification not found")
    note.is_read = True
    db.commit()
    return {"status": "success"}


class ManualSectionEntry(BaseModel):
    section_type: str
    content: str
    order: Optional[int] = None


class LegalAdvisorNote(BaseModel):
    section_id: str
    manual_content: str


@router.post("/parcels/{parcel_id}/opinion/manual-section")
def add_manual_section(
    parcel_id: str,
    entry: ManualSectionEntry,
    db: Session = Depends(get_db)
):
    """Add a new section manually by the legal advisor."""
    opinion = db.query(LegalOpinion).filter(LegalOpinion.parcel_id == parcel_id).first()
    if not opinion:
        raise HTTPException(404, "Opinion not found for this parcel")
    
    # Determine order if not provided
    if entry.order is None:
        max_order = db.query(func.max(OpinionSection.section_order)).filter(
            OpinionSection.opinion_id == opinion.id
        ).scalar() or 0
        entry.order = max_order + 1
    
    new_section = OpinionSection(
        id=gen_uuid(),
        opinion_id=opinion.id,
        section_type=entry.section_type,
        ai_draft_content=None,
        final_content=entry.content,
        section_order=entry.order,
        is_accepted=True
    )
    db.add(new_section)
    db.commit()
    
    return {
        "status": "success",
        "section_id": new_section.id,
        "message": f"Manual section '{entry.section_type}' added successfully"
    }


@router.post("/parcels/{parcel_id}/opinion/legal-advisor-note")
def add_legal_advisor_note(
    parcel_id: str,
    note: LegalAdvisorNote,
    db: Session = Depends(get_db)
):
    """Add a legal advisor note to an existing section."""
    opinion = db.query(LegalOpinion).filter(LegalOpinion.parcel_id == parcel_id).first()
    if not opinion:
        raise HTTPException(404, "Opinion not found for this parcel")
    
    section = db.query(OpinionSection).filter(
        OpinionSection.id == note.section_id,
        OpinionSection.opinion_id == opinion.id
    ).first()
    if not section:
        raise HTTPException(404, "Section not found")
    
    # Append the legal advisor note to final content
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M")
    advisor_note = f"\n\n---\n**Legal Advisor Note ({timestamp}):**\n{note.manual_content}"
    
    if section.final_content:
        section.final_content += advisor_note
    else:
        section.final_content = section.ai_draft_content or "" + advisor_note
    
    db.commit()
    
    return {
        "status": "success",
        "message": "Legal advisor note added successfully"
    }
