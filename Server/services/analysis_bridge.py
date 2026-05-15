import os
import json
import logging
import re
from datetime import datetime
from typing import List, Dict, Optional
from sqlalchemy.orm import Session
from common.database import SessionLocal
from common.landwise_models import (
    Parcel, OwnershipTransfer, Encumbrance, RiskFlag, 
    Owner, LandwiseDocument, ChecklistItem, AnalysisResult
)
from common.models import ECRecord, ValidationResult

logger = logging.getLogger(__name__)

class AnalysisBridge:
    """
    Bridges the gap between the legacy AI Validation system and the 
    new Landwise Database models.
    
    After the legacy pipeline runs, this bridge:
    1. Reads the output files (hierarchy_tree.json, ec_final.json, etc.)
    2. Stores them as JSONB in the `analysis_results` table
    3. Generates Mermaid diagram code from the hierarchy tree
    4. Syncs EC records -> OwnershipTransfers / Encumbrances
    5. Syncs Validation results -> RiskFlags
    """

    @staticmethod
    def sync_analysis_results(parcel_id: str, request_id: str, db: Session):
        """
        Fetches results from a legacy request_id and populates Landwise models.
        """
        logger.info(f"Syncing analysis results for parcel {parcel_id} (request_id: {request_id})")
        
        parcel = db.query(Parcel).filter(Parcel.id == parcel_id).first()
        if not parcel:
            logger.error(f"Parcel {parcel_id} not found during sync.")
            return

        # 1. Clear existing dynamic data (prevents duplicates on re-run)
        db.query(OwnershipTransfer).filter(OwnershipTransfer.parcel_id == parcel_id).delete()
        db.query(Encumbrance).filter(Encumbrance.parcel_id == parcel_id).delete()
        db.query(RiskFlag).filter(RiskFlag.parcel_id == parcel_id, RiskFlag.source == 'ai_auto').delete()
        db.query(AnalysisResult).filter(AnalysisResult.parcel_id == parcel_id).delete()
        
        # 2. Persist Pipeline Output Files to DB
        output_dir = os.path.join("outputs", "validate", request_id)
        AnalysisBridge._persist_pipeline_outputs(parcel_id, request_id, output_dir, db)

        # 3. Fetch Legacy EC Records for Timeline
        ec_records = db.query(ECRecord).filter(ECRecord.request_id == request_id).all()
        for rec in ec_records:
            AnalysisBridge._process_ec_record(parcel, rec, db)

        # 4. Fetch Legacy Validation Results for Risks
        val_results = db.query(ValidationResult).filter(ValidationResult.request_id == request_id).all()
        for res in val_results:
            AnalysisBridge._process_validation_result(parcel, res, db)

        # 5. Final Updates
        parcel.last_analysis_request_id = request_id
        db.commit()
        logger.info(f"Sync complete for parcel {parcel_id}")

    @staticmethod
    def _persist_pipeline_outputs(parcel_id: str, request_id: str, output_dir: str, db: Session):
        """Reads output JSON files and stores them in analysis_results table."""
        
        # --- hierarchy_tree.json ---
        hierarchy_path = os.path.join(output_dir, "hierarchy_tree.json")
        hierarchy_data = None
        if os.path.exists(hierarchy_path):
            try:
                with open(hierarchy_path, "r", encoding="utf-8") as f:
                    hierarchy_data = json.load(f)
                db.add(AnalysisResult(
                    parcel_id=parcel_id,
                    request_id=request_id,
                    result_type="hierarchy_tree",
                    data=hierarchy_data
                ))
                logger.info(f"Stored hierarchy_tree for parcel {parcel_id}")
            except Exception as e:
                logger.error(f"Failed to persist hierarchy_tree: {e}")

        # --- ec_final.json ---
        ec_final_path = os.path.join(output_dir, "ec_final.json")
        if os.path.exists(ec_final_path):
            try:
                with open(ec_final_path, "r", encoding="utf-8") as f:
                    ec_data = json.load(f)
                db.add(AnalysisResult(
                    parcel_id=parcel_id,
                    request_id=request_id,
                    result_type="ec_final",
                    status="completed",
                    data=ec_data
                ))
                logger.info(f"Stored ec_final for parcel {parcel_id}")
            except Exception as e:
                logger.error(f"Failed to persist ec_final: {e}")

        # --- final_result.json (contains validation results array) ---
        final_result_path = os.path.join(output_dir, "final_result.json")
        if os.path.exists(final_result_path):
            try:
                with open(final_result_path, "r", encoding="utf-8") as f:
                    final_data = json.load(f)
                results_list = final_data.get("results", [])
                if results_list:
                    db.add(AnalysisResult(
                        parcel_id=parcel_id,
                        request_id=request_id,
                        result_type="validation_results",
                        status="completed",
                        data=results_list
                    ))
                    logger.info(f"Stored validation_results for parcel {parcel_id}")
            except Exception as e:
                logger.error(f"Failed to persist validation_results: {e}")

        # --- Generate & Store Mermaid Code from hierarchy ---
        if hierarchy_data:
            try:
                mermaid_code = AnalysisBridge._generate_mermaid_from_hierarchy(hierarchy_data)
                db.add(AnalysisResult(
                    parcel_id=parcel_id,
                    request_id=request_id,
                    result_type="mermaid_code",
                    data={"code": mermaid_code}
                ))
                logger.info(f"Stored mermaid_code for parcel {parcel_id}")
            except Exception as e:
                logger.error(f"Failed to generate/persist mermaid_code: {e}")

    @staticmethod
    def _generate_mermaid_from_hierarchy(tree_data: list) -> str:
        """Converts a hierarchy tree JSON into a Mermaid flowchart string."""
        lines = ["flowchart TD"]
        node_counter = [0]
        links = []

        def _parse_date_for_sort(date_str: str) -> str:
            try:
                if '-' in date_str:
                    parts = date_str.split('-')
                    if len(parts) == 3:
                        months = {
                            'Jan': '01', 'Feb': '02', 'Mar': '03', 'Apr': '04', 'May': '05', 'Jun': '06',
                            'Jul': '07', 'Aug': '08', 'Sep': '09', 'Oct': '10', 'Nov': '11', 'Dec': '12'
                        }
                        m = months.get(parts[1][:3], '01')
                        return f"{parts[2]}-{m}-{parts[0].zfill(2)}"
                parts = date_str.split('/')
                if len(parts) == 3:
                    return f"{parts[2]}-{parts[1].zfill(2)}-{parts[0].zfill(2)}"
            except:
                pass
            return "0000-00-00"

        def _escape(text: str) -> str:
            """Escape special Mermaid characters in labels."""
            if not text:
                return "N/A"
            return str(text).replace('"', "'").replace('<', '').replace('>', '').replace('&', 'and')

        def build_nodes(nodes, parent_id=None):
            def get_min_date(n):
                txs = n.get('transactions', [])
                current_min = "9999-12-31"
                if txs:
                    current_min = _parse_date_for_sort(min(txs, key=lambda x: _parse_date_for_sort(x.get('date', '9999'))).get('date', '9999'))
                children = n.get('children', {})
                child_list = list(children.values()) if isinstance(children, dict) else children
                for c in child_list:
                    c_min = get_min_date(c)
                    if c_min < current_min:
                        current_min = c_min
                return current_min

            sorted_nodes = sorted(nodes, key=get_min_date)
            for node in sorted_nodes:
                sn = _escape(node.get('survey_number', 'N/A'))
                txs = sorted(node.get('transactions', []), key=lambda x: _parse_date_for_sort(x.get('date', '')))
                
                current_link_parent = parent_id
                if not txs:
                    node_counter[0] += 1
                    safe_id = f"sn_{node_counter[0]}"
                    lines.append(f'    {safe_id}["S.No: {sn}"]:::base')
                    if parent_id:
                        links.append(f"    {parent_id} --> {safe_id}")
                    current_link_parent = safe_id
                else:
                    for tx in txs:
                        node_counter[0] += 1
                        safe_id = f"tx_{node_counter[0]}"
                        doc_no = _escape(tx.get('document_number', 'N/A'))
                        nat = (tx.get('nature') or tx.get('nature_of_document', '')).lower()
                        style = "sale" if any(x in nat for x in ['sale', 'conveyance']) else ("mortgage" if 'mortgage' in nat else "base")
                        
                        date_str = _escape(tx.get('date', 'N/A'))
                        label = f"{doc_no} | S.No: {sn} | {date_str}"
                        lines.append(f'    {safe_id}["{label}"]:::{style}')
                        if current_link_parent:
                            links.append(f"    {current_link_parent} --> {safe_id}")
                        current_link_parent = safe_id

                children = node.get('children', {})
                child_list = list(children.values()) if isinstance(children, dict) else children
                build_nodes(child_list, current_link_parent)

        build_nodes(tree_data)
        lines.extend(links)
        lines.extend([
            "    classDef base fill:#f1f5f9,stroke:#64748b,color:#334155,stroke-width:1px;",
            "    classDef sale fill:#dcfce7,stroke:#16a34a,color:#14532d,stroke-width:2px;",
            "    classDef mortgage fill:#fee2e2,stroke:#dc2626,color:#7f1d1d,stroke-width:2px;"
        ])
        return "\n".join(lines)

    @staticmethod
    def _process_ec_record(parcel: Parcel, rec: ECRecord, db: Session):
        """
        Transforms an EC Record into an OwnershipTransfer or Encumbrance.
        """
        nature = (rec.nature or "").lower()
        
        # Identify if it's a transfer (Sale, Gift, etc.)
        transfer_types = ['sale', 'gift', 'settlement', 'release', 'partition', 'exchange']
        is_transfer = any(t in nature for t in transfer_types)
        
        # Clean date
        reg_date = None
        if rec.date:
            try:
                reg_date = datetime.strptime(rec.date, "%Y-%m-%d").date()
            except:
                pass

        if is_transfer:
            # Create Owners (Simplified for now)
            from_owner = None
            if rec.executant:
                from_owner = AnalysisBridge._get_or_create_owner(parcel.id, rec.executant, db)
            
            to_owner = None
            if rec.claimant:
                to_owner = AnalysisBridge._get_or_create_owner(parcel.id, rec.claimant, db)

            transfer = OwnershipTransfer(
                parcel_id=parcel.id,
                transfer_type=nature,
                from_owner_id=from_owner.id if from_owner else None,
                to_owner_id=to_owner.id if to_owner else None,
                registration_date=reg_date,
                transfer_date=reg_date,
                registration_number=rec.document_number,
                consideration_amount=None # Extract from JSON if needed
            )
            db.add(transfer)
        else:
            # Assume it's an encumbrance if it's a mortgage or charge
            enc_types = ['mortgage', 'deposit of title deeds', 'charge', 'court attachment']
            is_enc = any(t in nature for t in enc_types)
            if is_enc:
                enc = Encumbrance(
                    parcel_id=parcel.id,
                    encumbrance_type=nature,
                    holder_name=rec.claimant or "Beneficiary",
                    created_date=reg_date,
                    status='active'
                )
                db.add(enc)

    @staticmethod
    def _process_validation_result(parcel: Parcel, res: ValidationResult, db: Session):
        """
        Transforms a Validation Result into Risk Flags.
        """
        if not res.match:
            # Create a high severity risk flag
            risk = RiskFlag(
                parcel_id=parcel.id,
                risk_category='title_defect',
                severity='high',
                source='ai_auto',
                description=f"Validation failed for Document {res.document_number}: {res.reason_for_failure or 'Data mismatch detected between EC and Deed.'}",
                action='pending'
            )
            db.add(risk)
        elif res.trustability_score and res.trustability_score < 70:
            # Create a medium risk flag for low confidence
            risk = RiskFlag(
                parcel_id=parcel.id,
                risk_category='compliance',
                severity='medium',
                source='ai_auto',
                description=f"Low trustability score ({res.trustability_score}%) for Document {res.document_number}. Human review recommended.",
                action='pending'
            )
            db.add(risk)

    @staticmethod
    def _get_or_create_owner(parcel_id: str, name: str, db: Session) -> Owner:
        owner = db.query(Owner).filter(Owner.parcel_id == parcel_id, Owner.name == name).first()
        if not owner:
            owner = Owner(
                parcel_id=parcel_id,
                name=name,
                owner_type='individual' # Default
            )
            db.add(owner)
            db.flush() # Get ID
        return owner
