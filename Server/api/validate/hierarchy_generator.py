import os
import json
import re
import fitz # PyMuPDF
from typing import List, Dict, Any, Optional, Set
from pypdf import PdfReader
from common.gemini_helper import GeminiHelper
from prompts.hierarchy_prompts import HIERARCHY_PROMPT

class HierarchyGenerator:
    def __init__(self, output_dir: str, model_id: str = None):
        self.output_dir = output_dir
        self.node_counter = 0
        self.temp_tx_counter = 0
        self.current_x = 250
        self.current_y = 0
        self.gemini = GeminiHelper(model_id=model_id or "gemini-2.5-flash")
        if self.output_dir:
            os.makedirs(self.output_dir, exist_ok=True)

    def _normalize_sn(self, sn: str) -> str:
        """Normalizes survey numbers for robust comparison."""
        if not sn: return ""
        return str(sn).strip().upper().replace(" ", "")

    def extract_text(self, pdf_path: str) -> str:
        """Extracts text from the entire PDF."""
        text = ""
        with fitz.open(pdf_path) as doc:
            for page in doc:
                text += (page.get_text() or "") + "\n"
        return text

    def get_hierarchy_data(self, text: str) -> List[Dict[str, Any]]:
        """Sends text to LLM and gets complete hierarchical structure."""
        response = self.gemini.generate_from_text(text, HIERARCHY_PROMPT)
        clean_response = re.sub(r"```json\s*|\s*```", "", response).strip()
        try:
            hierarchy = json.loads(clean_response)
            return hierarchy
        except json.JSONDecodeError as e:
            print(f"JSON parsing error: {e}")
            return []

    def is_valid_sn(self, s: str) -> bool:
        """Validates if a survey number string appears to be legitimate."""
        if not s: return False
        s_str = str(s).strip().lower()
        if len(s_str) < 1 or len(s_str) > 50: return False
        
        # Keywords that indicate descriptive text instead of a survey number
        invalid_patterns = [
            "nature", "extent", "boundar", "schedule", "doc", "page", 
            "reg", "dist", "taluk", "village", "s.no", "survey",
            "boun", "east", "west", "north", "south", "property", "land",
            "val", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
            "வீட்டுமனை", "விவரிப்பு", "புலம்"
        ]
        if any(bad in s_str for bad in invalid_patterns): return False
        if not any(c.isdigit() for c in s_str): return False 
        return True

    def _get_parent_sn(self, sn: str, all_sns: List[str]) -> Optional[str]:
        """
        Returns the single most direct parent survey number based on prefix rules.
        """
        sn = self._normalize_sn(sn)
        if not sn: return None
        
        potential_parents = []
        for p in all_sns:
            p_norm = self._normalize_sn(p)
            if p_norm == sn: continue
            
            if sn.startswith(p_norm):
                rem = sn[len(p_norm):]
                if rem.startswith('/') or p_norm.endswith('/'):
                    potential_parents.append(p_norm)
                elif len(p_norm) > 0 and p_norm[-1].isdigit() and (not rem or not rem[0].isdigit()):
                    potential_parents.append(p_norm)
                elif len(p_norm) > 0 and not p_norm[-1].isdigit():
                    potential_parents.append(p_norm)

        if not potential_parents:
            if '/' in sn:
                return sn.rsplit('/', 1)[0]
            return None
            
        # Return the most direct parent (longest match)
        return max(potential_parents, key=len)

    def _repair_hierarchy_data(self, hierarchy_data: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """
        REPAIR LOGIC:
        1. Flattens transactions and ensures SN validity.
        2. Infers missing SNs from sequential document neighbors (Batch extraction fix).
        3. Rebuilds Mother -> Child -> Grandchild tree based on prefix rules.
        """
        all_txs = []
        
        def flatten_tree(nodes, current_sn=None):
            for node in nodes:
                node_sn = node.get('survey_number', current_sn)
                for tx in node.get('transactions', []):
                    tx_sn = tx.get('survey_number')
                    if not self.is_valid_sn(tx_sn):
                        tx_sn = node_sn
                    tx['survey_number'] = tx_sn
                    all_txs.append(tx)
                
                children = node.get('children', {})
                if isinstance(children, dict): flatten_tree(children.values(), node_sn)
                else: flatten_tree(children, node_sn)

        flatten_tree(hierarchy_data)
        
        # 1. Sort by Document Number Sequence
        def get_doc_seq(tx):
            doc = str(tx.get('document_number', '0/0'))
            if '/' in doc:
                parts = doc.split('/')
                try: return (int(parts[1]), int(parts[0]))
                except: pass
            return (0, 0)
        all_txs.sort(key=get_doc_seq)
        
        # 2. Sequential Neighbor Inference for Orphans (Extract map properly workaround)
        for i, tx in enumerate(all_txs):
            if not self.is_valid_sn(tx.get('survey_number')):
                inferred = None
                for offset in [-1, 1, -2, 2, -3, 3, -4, 4, -5, 5]:
                    idx = i + offset
                    if 0 <= idx < len(all_txs):
                        neighbor = all_txs[idx]
                        if self.is_valid_sn(neighbor.get('survey_number')):
                            if get_doc_seq(neighbor)[0] == get_doc_seq(tx)[0]:
                                inferred = neighbor.get('survey_number')
                                break
                if inferred: tx['survey_number'] = inferred

        # 3. Group and Rebuild Tree
        by_sn = {}
        processed_doc_nos = set()
        
        # First pass: Create nodes and aggregate transactions
        for tx in all_txs:
            raw_sn = tx.get('survey_number') or "ROOT"
            sns = [s.strip() for s in str(raw_sn).split(',') if self.is_valid_sn(s.strip())]
            if not sns: sns = [raw_sn if self.is_valid_sn(raw_sn) else "ROOT"]
            
            for sn in sns:
                sn_norm = self._normalize_sn(sn)
                if sn_norm not in by_sn:
                    by_sn[sn_norm] = {"survey_number": sn, "transactions": [], "children": {}}
                
                # Check for document uniqueness within this SN path
                doc_key = f"{sn_norm}_{tx.get('document_number')}"
                if doc_key not in processed_doc_nos:
                    by_sn[sn_norm]["transactions"].append(tx)
                    processed_doc_nos.add(doc_key)
                
                # Ensure ancestors exist in by_sn for deep hierarchy
                current_sn = sn
                while True:
                    p_sn = None
                    if '/' in current_sn:
                        base, last_part = current_sn.rsplit('/', 1)
                        # Check for alphanumeric subdivision at the END of the current_sn path
                        # Example: 222/6A -> 222/6
                        match = re.match(r'^(\d+)[A-Z]+$', last_part.upper())
                        if match:
                            p_sn = f"{base}/{match.group(1)}"
                        else:
                            # Fallback to pure slash split: 222/6 -> 222
                            p_sn = base
                    else:
                        # Plain alphanumeric split: 6A -> 6
                        match = re.match(r'^(\d+)[A-Z]+$', current_sn.upper())
                        if match:
                            p_sn = match.group(1)
                    
                    if not p_sn: break
                    
                    p_norm = self._normalize_sn(p_sn)
                    if not p_norm or p_norm == self._normalize_sn(current_sn): break
                    
                    if p_norm not in by_sn:
                        by_sn[p_norm] = {"survey_number": p_sn, "transactions": [], "children": {}}
                    
                    current_sn = p_sn

        # 4. Link into Hierarchy based on Parent Logic
        all_child_keys = set()
        sn_keys = list(by_sn.keys())
        
        for sn_norm in sorted(sn_keys, key=len, reverse=True):
            node = by_sn[sn_norm]
            parent_sn = self._get_parent_sn(node["survey_number"], [by_sn[k]["survey_number"] for k in sn_keys])
            if parent_sn:
                parent_norm = self._normalize_sn(parent_sn)
                if parent_norm in by_sn:
                    # Avoid cyclic links
                    if parent_norm != sn_norm:
                        by_sn[parent_norm]["children"][sn_norm] = node
                        all_child_keys.add(sn_norm)

        # 5. Clean and Sort
        for sn in by_sn:
            by_sn[sn]["transactions"].sort(key=lambda x: self._parse_date_for_sort(x.get('date', '')))
            
        final_roots = [by_sn[k] for k in by_sn if k not in all_child_keys]
        return final_roots

    def generate_visual_html(self, tree_data: List[Dict[str, Any]], output_path: str, matched_docs: List[Dict[str, Any]] = None, source_docs_dir: str = None, limit: Optional[int] = None):
        """Generates the interactive HTML visualization with fixed tooltips."""
        node_data_map = {}
        doc_urls = {}
        
        if matched_docs:
            for d in matched_docs:
                d_no = d.get('document_number')
                f_path = d.get('file_path')
                if d_no and f_path:
                    url = "http://localhost:8000/files/" + f_path.replace('\\', '/')
                    doc_urls[d_no] = url
                    norm_no = re.sub(r'[^0-9]', '', str(d_no))
                    if norm_no: doc_urls[f"norm_{norm_no}"] = url

        all_transactions_map = {}
        def collect_tx(nodes):
            for node in nodes:
                sn = node.get('survey_number', 'N/A')
                for tx in node.get('transactions', []):
                    d_no = tx.get('document_number', 'N/A')
                    if d_no not in all_transactions_map:
                        all_transactions_map[d_no] = {
                            "date": tx.get('date', 'N/A'), "doc": d_no,
                            "nature": tx.get('nature') or tx.get('nature_of_document', 'N/A'),
                            "survey": sn, "executant": tx.get('executant', 'N/A'),
                            "claimant": tx.get('claimant', 'N/A'), "sq_feet": tx.get('square_feet', 'N/A'),
                            "supporting_docs": tx.get('supporting_documents', 'None mentioned')
                        }
                children = node.get('children', {})
                collect_tx(children.values() if isinstance(children, dict) else children)

        collect_tx(tree_data)
        sorted_tx_list = sorted(all_transactions_map.values(), key=lambda x: self._parse_date_for_sort(x['date']))

        mermaid_lines = ["flowchart TD"]
        self.node_counter = 0
        links = []

        def build_mermaid_nodes(nodes, parent_tx_id=None):
            def get_min_date(n):
                txs = n.get('transactions', [])
                current_min = "9999-12-31"
                if txs:
                    current_min = self._parse_date_for_sort(min(txs, key=lambda x: self._parse_date_for_sort(x.get('date', '9999'))).get('date', '9999'))
                
                # Recurse into children to find the true timeline start for this branch
                children = n.get('children', {})
                child_list = list(children.values()) if isinstance(children, dict) else children
                for c in child_list:
                    c_min = get_min_date(c)
                    if c_min < current_min:
                        current_min = c_min
                return current_min
            
            sorted_nodes = sorted(nodes, key=get_min_date)
            for node in sorted_nodes:
                sn = node.get('survey_number', 'N/A')
                txs = sorted(node.get('transactions', []), key=lambda x: self._parse_date_for_sort(x.get('date', '')))
                
                current_link_parent = parent_tx_id
                if not txs:
                    self.node_counter += 1
                    safe_id = f"sn_node_{self.node_counter}"
                    mermaid_lines.append(f'    {safe_id}["S.No: {sn}"]:::base')
                    if parent_tx_id: links.append(f"    {parent_tx_id} --> {safe_id}")
                    current_link_parent = safe_id
                    
                    # Ensure structural nodes have tooltip data
                    node_data_map[safe_id] = {
                        "date": "N/A", "doc": "NO TRANSACTION FOUND", "survey": sn,
                        "nature": "Structural Node (Not present in EC transactions)",
                        "executant": "N/A", "claimant": "N/A",
                        "sq_feet": "N/A", "supporting_docs": "This node was inferred from subdivisions to maintain structural hierarchy."
                    }
                else:
                    for tx in txs:
                        self.node_counter += 1
                        safe_id = f"tx_node_{self.node_counter}"
                        doc_no = tx.get('document_number', 'N/A')
                        nat = (tx.get('nature') or tx.get('nature_of_document', '')).lower()
                        style = "sale" if any(x in nat for x in ['sale', 'conveyance']) else ("mortgage" if 'mortgage' in nat else "base")
                        
                        label = f"<b>{doc_no}</b><br/><small>S.No: {sn}</small><br/><small>{tx.get('date', 'N/A')}</small>"
                        mermaid_lines.append(f'    {safe_id}["{label}"]:::{style}')
                        if current_link_parent: links.append(f"    {current_link_parent} --> {safe_id}")
                        current_link_parent = safe_id
                        
                        node_data_map[safe_id] = {
                            "date": tx.get('date', 'N/A'), "doc": doc_no, "survey": sn,
                            "nature": tx.get('nature') or tx.get('nature_of_document', 'N/A'),
                            "executant": tx.get('executant', 'N/A'), "claimant": tx.get('claimant', 'N/A'),
                            "sq_feet": tx.get('square_feet', 'N/A'), "supporting_docs": tx.get('supporting_documents', 'None mentioned')
                        }
                children = node.get('children', {})
                build_mermaid_nodes(children.values() if isinstance(children, dict) else children, current_link_parent)

        build_mermaid_nodes(tree_data)
        mermaid_lines.extend(links)
        mermaid_lines.extend([
            "    classDef base fill:#f8f9fa,stroke:#2c3e50,color:#2c3e50,stroke-width:1px;",
            "    classDef sale fill:#d4edda,stroke:#28a745,color:#155724,stroke-width:2px;",
            "    classDef mortgage fill:#f8d7da,stroke:#dc3545,color:#721c24,stroke-width:2px;"
        ])

        html_template = """<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Property Management Lineage</title>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/mermaid/10.9.0/mermaid.min.js"></script>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/list.js/2.3.1/list.min.js"></script>
    <style>
        :root { --primary: #0f172a; --secondary: #3b82f6; --bg: #f8fafc; }
        body { font-family: 'Segoe UI', system-ui, sans-serif; background: var(--bg); margin: 0; padding: 20px; color: #1e293b; }
        .layout { display: flex; gap: 20px; height: 92vh; }
        .card { background: #fff; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.08); padding: 20px; display: flex; flex-direction: column; border: 1px solid #e2e8f0; }
        .mermaid-card { flex: 3; position: relative; } .table-card { flex: 2; }
        .scroll-area { flex: 1; overflow: auto; margin-top: 15px; border-radius: 8px; border: 1px solid #f1f5f9; }
        table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
        th { background: #f8fafc; padding: 12px; text-align: left; border-bottom: 2px solid #e2e8f0; position: sticky; top: 0; }
        td { padding: 12px; border-bottom: 1px solid #f1f5f9; }
        .mermaid .node { cursor: pointer; }
        #node-tooltip { 
            position: fixed; display: none; background: rgba(15, 23, 42, 0.98); 
            color: #f8fafc; padding: 20px; border-radius: 12px; z-index: 99999; 
            width: 360px; font-size: 0.85rem; box-shadow: 0 25px 50px -12px rgba(0,0,0,0.5); 
            pointer-events: none; border: 1px solid rgba(255,255,255,0.1); 
            backdrop-filter: blur(12px); transition: opacity 0.1s ease; opacity: 0;
        }
        .tooltip-header { font-weight: 800; border-bottom: 1px solid #3b82f6; margin-bottom: 12px; padding-bottom: 8px; color: #60a5fa; font-size: 1rem; }
        .tooltip-row { display: flex; margin-bottom: 8px; } 
        .tooltip-label { width: 100px; font-weight: 600; color: #94a3b8; font-size: 0.75rem; text-transform: uppercase; }
        .tooltip-value { flex: 1; line-height: 1.5; }
        #preview-modal { display: none; position: fixed; inset: 0 0 0 auto; width: 45%; background: white; z-index: 100000; flex-direction: column; box-shadow: -10px 0 50px rgba(0,0,0,0.3); }
        .modal-header { padding: 16px; background: var(--primary); color: white; display: flex; justify-content: space-between; align-items: center; }
        iframe { width: 100%; flex: 1; border: none; }
    </style>
</head>
<body>
    <div class="layout">
        <div class="card mermaid-card">
            <h2 style="margin:0;">Interactive Lineage Map</h2>
            <div class="scroll-area mermaid" id="main-mermaid">__CODE__</div>
        </div>
        <div class="card table-card" id="tx-container">
            <h2 style="margin:0;">Sequence History</h2>
            <input type="text" class="search" placeholder="Search transactions..." style="width:100%; border:1px solid #e2e8f0; padding:10px; margin:15px 0; border-radius:8px;" />
            <div class="scroll-area">
                <table>
                    <thead><tr><th class="sort" data-sort="date">Date</th><th class="sort" data-sort="doc">Document</th><th>Parties</th></tr></thead>
                    <tbody class="list"></tbody>
                </table>
            </div>
        </div>
    </div>
    <div id="node-tooltip"></div>
    <div id="preview-modal">
        <div class="modal-header"><h3 id="modal-title" style="margin:0;">Preview</h3><button onclick="closePreview()" style="background:none; border:none; color:white; font-size: 1.5rem; cursor:pointer;">&times;</button></div>
        <iframe id="preview-iframe"></iframe>
    </div>
    <script>
        mermaid.initialize({ startOnLoad: true, theme: 'neutral', securityLevel: 'loose', flowchart: { htmlLabels: true, curve: 'basis' } });
        const allTransactions = __JSON__;
        const nodeDataMap = __NODE_DATA__;
        const docUrls = __DOC_URLS__;
        const tooltip = document.getElementById('node-tooltip');

        const tbody = document.querySelector('.list');
        allTransactions.forEach(item => {
            const tr = document.createElement('tr');
            tr.innerHTML = `<td class="date">${item.date}</td><td class="doc"><b>${item.doc}</b><br/><small>${item.survey}</small></td><td class="parties">${item.executant}<br/><small>→ ${item.claimant}</small></td>`;
            tr.onclick = () => onNodeClick(item.doc);
            tbody.appendChild(tr);
        });
        new List('tx-container', { valueNames: ['date', 'doc'] });

        let activeNodeId = null;

        function showTooltip(e, nodeId) {
            if (activeNodeId === nodeId) {
                updateTooltipPos(e);
                return;
            }
            activeNodeId = nodeId;
            const data = nodeDataMap[nodeId];
            if (!data) return;
            tooltip.innerHTML = `<div class="tooltip-header">${data.doc}</div>` +
                `<div class="tooltip-row"><span class="tooltip-label">Date:</span><span class="tooltip-value">${data.date}</span></div>` +
                `<div class="tooltip-row"><span class="tooltip-label">S.No:</span><span class="tooltip-value" style="color:#60a5fa; font-weight:bold">${data.survey}</span></div>` +
                `<div class="tooltip-row"><span class="tooltip-label">Nature:</span><span class="tooltip-value">${data.nature}</span></div>` +
                `<div class="tooltip-row"><span class="tooltip-label">From:</span><span class="tooltip-value">${data.executant}</span></div>` +
                `<div class="tooltip-row"><span class="tooltip-label">To:</span><span class="tooltip-value">${data.claimant}</span></div>` +
                `<div class="tooltip-row"><span class="tooltip-label">Extent:</span><span class="tooltip-value">${data.sq_feet}</span></div>`;
            tooltip.style.display = 'block';
            setTimeout(() => { tooltip.style.opacity = '1'; }, 10);
            updateTooltipPos(e);
        }

        function updateTooltipPos(e) {
            let x = e.clientX + 20; let y = e.clientY + 20;
            if (x + 360 > window.innerWidth) x = e.clientX - 380;
            if (y + 300 > window.innerHeight) y = window.innerHeight - 320;
            tooltip.style.left = x + 'px';
            tooltip.style.top = y + 'px';
        }

        document.addEventListener('mouseover', (e) => {
            const node = e.target.closest('.node');
            if (node) {
                const fullId = node.id || node.getAttribute('id') || "";
                // Fix: Sort keys by length descending and use precise boundary matching
                // to prevent "tx_node_1" from matching "tx_node_10"
                const keys = Object.keys(nodeDataMap).sort((a, b) => b.length - a.length);
                const matchedKey = keys.find(key => {
                    const regex = new RegExp('(^|[^a-zA-Z0-9])' + key + '($|[^a-zA-Z0-9])');
                    return regex.test(fullId);
                });
                if (matchedKey) {
                    showTooltip(e, matchedKey);
                }
            }
        });

        document.addEventListener('mousemove', (e) => { 
            if (activeNodeId) updateTooltipPos(e); 
        });
        
        document.addEventListener('mouseout', (e) => { 
            const node = e.target.closest('.node');
            const toNode = e.relatedTarget ? e.relatedTarget.closest('.node') : null;
            if (node && node !== toNode) {
                activeNodeId = null;
                tooltip.style.opacity = '0';
                setTimeout(() => { if (!activeNodeId) tooltip.style.display = 'none'; }, 100);
            } 
        });

        window.onNodeClick = (docNo) => {
            const url = docUrls[docNo] || docUrls['norm_' + docNo.replace(/[^0-9]/g, '')];
            if (url) {
                document.getElementById('modal-title').textContent = "Preview: " + docNo;
                document.getElementById('preview-iframe').src = url;
                document.getElementById('preview-modal').style.display = 'flex';
            }
        };
        window.closePreview = () => { 
            document.getElementById('preview-modal').style.display = 'none'; 
            document.getElementById('preview-iframe').src = ''; 
        };
    </script>
</body>
</html>"""
        final_html = html_template.replace('__CODE__', "\n".join(mermaid_lines))
        final_html = final_html.replace('__JSON__', json.dumps(sorted_tx_list, ensure_ascii=False))
        final_html = final_html.replace('__NODE_DATA__', json.dumps(node_data_map, ensure_ascii=False))
        final_html = final_html.replace('__DOC_URLS__', json.dumps(doc_urls, ensure_ascii=False))
        
        with open(output_path, 'w', encoding='utf-8') as f:
            f.write(final_html)

    def _parse_date_for_sort(self, date_str: str):
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
        except: pass
        return "0000-00-00"

    def build_hierarchy_programmatically(self, flat_data: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        normalized_txs = []
        for item in flat_data:
            tx = {
                "claimant": ", ".join(item.get('buyers', [])) if isinstance(item.get('buyers'), list) else str(item.get('buyers', 'N/A')),
                "executant": ", ".join(item.get('sellers', [])) if isinstance(item.get('sellers'), list) else str(item.get('sellers', 'N/A')),
                "survey_number": item.get('survey_number', 'N/A'),
                "date": item.get('date', 'N/A'),
                "nature": item.get('nature_of_document', 'N/A'),
                "document_number": item.get('document_number', 'N/A'),
                "nature_of_land": item.get('property_type', 'Agricultural Land'),
                "square_feet": str(item.get('property_extent', 'N/A')),
                "supporting_documents": "None mentioned"
            }
            normalized_txs.append(tx)
        return self._repair_hierarchy_data([{"survey_number": "ROOT", "transactions": normalized_txs, "children": {}}])

    def _generate_react_flow_data(self, nodes: List[Dict[str, Any]], parent_id: Optional[str] = None, doc_map: Dict[str, str] = None, allowed_docs: Optional[Set[str]] = None) -> Dict[str, Any]:
        """Converts hierarchical tree into React Flow nodes and edges."""
        rf_nodes = []
        rf_edges = []
        
        API_URL = os.getenv("VITE_API_URL", "http://localhost:8000")

        def traverse(node_list, p_id=None, level=0, x_offset=0, y_offset=0):
            # Sort nodes by earliest transaction date for consistent horizontal layout
            def get_min_date(n):
                txs = n.get('transactions', [])
                current_min = "9999-12-31"
                if txs:
                    current_min = min([self._parse_date_for_sort(t.get('date', '9999')) for t in txs])
                
                # Recurse into children so structural nodes align with their first child
                children = n.get('children', {})
                child_list = list(children.values()) if isinstance(children, dict) else children
                for c in child_list:
                    c_min = get_min_date(c)
                    if c_min < current_min:
                        current_min = c_min
                return current_min
            
            sorted_nodes = sorted(node_list, key=get_min_date)
            
            # Root nodes should be spaced very far apart to prevent subtree overlap
            spacing = 1800 if level == 0 else 450
            if level == 0:
                # Root level: Spread out the mothers from the global center
                total_width = (len(sorted_nodes) - 1) * spacing
                current_level_x_start = -(total_width / 2)
            else:
                # Child level: Center recursively under parent x_offset
                total_width = (len(sorted_nodes) - 1) * spacing
                current_level_x_start = x_offset - (total_width / 2)

            # Max transactions in this level to calculate child y_offset
            max_txs_in_node = 0

            for idx, node in enumerate(sorted_nodes):
                sn = node.get('survey_number', 'N/A')
                # Filter transactions if whitelist provided
                all_txs = sorted(node.get('transactions', []), key=lambda x: self._parse_date_for_sort(x.get('date', '')))
                txs = [t for t in all_txs if not allowed_docs or t.get('document_number') in allowed_docs]
                
                # Update max transactions
                max_txs_in_node = max(max_txs_in_node, len(txs))

                # Calculate node X based on centering logic
                node_x = current_level_x_start + (idx * spacing)
                node_y = y_offset # Use dynamic y-offset
                
                current_chain_parent = p_id

                if not txs and not node.get('children'):
                    # Only show abstract SN nodes if they have children or were explicitly matched
                    if not p_id: # Show root SN nodes even if empty
                        self.node_counter += 1
                        node_id = f"sn_{self.node_counter}"
                        rf_nodes.append({
                            "id": node_id,
                            "type": "default",
                            "position": {"x": node_x, "y": node_y},
                            "data": {"label": f"S.No: {sn}", "survey_number": sn, "level": level},
                            "className": "sn-node"
                        })
                        current_chain_parent = node_id
                elif not txs:
                    # Abstract S.No node that acts as a container for children
                    self.node_counter += 1
                    node_id = f"sn_{self.node_counter}"
                    rf_nodes.append({
                        "id": node_id,
                        "type": "default",
                        "position": {"x": node_x, "y": node_y},
                        "data": {
                            "label": f"S.No: {sn}", 
                            "survey_number": sn, 
                            "level": level,
                            "document_number": "NO TRANSACTION FOUND",
                            "nature": "Not present in EC transactions",
                            "executant": "N/A",
                            "claimant": "N/A",
                            "sq_feet": "N/A",
                            "notes": "This structural parent was added because subdivisions (children) exist, though this specific node has no transactions in the EC."
                        },
                        "className": "sn-node"
                    })
                    if p_id:
                        rf_edges.append({"id": f"e_{p_id}_{node_id}", "source": p_id, "target": node_id})
                    current_chain_parent = node_id
                else:
                    # Create a chain of transactions for this survey number
                    last_tx_node_id = None
                    for t_idx, tx in enumerate(txs):
                        self.node_counter += 1
                        node_id = f"tx_{self.node_counter}"
                        doc_no = tx.get('document_number', 'N/A')
                        nat = (tx.get('nature') or tx.get('nature_of_document', 'N/A'))
                        ex = tx.get('executant', 'N/A')
                        cl = tx.get('claimant', 'N/A')
                        
                        style_class = "base-node"
                        nature_lower = nat.lower()
                        # Support for both English and Tamil (TN Registry) keywords
                        if any(x in nature_lower for x in ['sale', 'conveyance', 'kraya', 'விற்பனை', 'கிரைய']): 
                            style_class = "sale-node"
                        elif any(x in nature_lower for x in ['mortgage', 'hypothecation', 'adamanam', 'அடமான']): 
                            style_class = "mortgage-node"
                        elif any(x in nature_lower for x in ['gift', 'dhana', 'தான', 'செட்டில்மெண்ட்']): 
                            style_class = "gift-node"
                        elif 'settlement' in nature_lower: 
                            style_class = "settlement-node"
                        elif any(x in nature_lower for x in ['release', 'viduthalai', 'விடுதலை']): 
                            style_class = "release-node"
                        elif any(x in nature_lower for x in ['partition', 'baaga', 'பாக']): 
                            style_class = "partition-node"
                        elif any(x in nature_lower for x in ['power of attorney', 'aathara', 'அதிகார']): 
                            style_class = "power-node"
                        
                        # Apply PDF Mapping
                        pdf_path = doc_map.get(doc_no) if doc_map else None
                        pdf_url = pdf_path if pdf_path else None

                        # Enhanced Label
                        rich_label = f"Doc: {doc_no}\nS.No: {sn}\nNature: {nat}\nEx: {ex[:30]}"

                        rf_nodes.append({
                            "id": node_id,
                            "type": "default",
                            "position": {"x": node_x, "y": node_y + (t_idx * 160)},
                            "data": {
                                "label": rich_label,
                                "document_number": doc_no,
                                "survey_number": sn,
                                "level": level,
                                "date": tx.get('date', 'N/A'),
                                "nature": nat,
                                "executant": ex,
                                "claimant": cl,
                                "sq_feet": tx.get('square_feet', 'N/A'),
                                "pdf_url": pdf_url,
                                "notes": tx.get('notes', '')
                            },
                            "className": style_class
                        })
                        
                        if t_idx == 0 and current_chain_parent:
                            rf_edges.append({
                                "id": f"e_{current_chain_parent}_{node_id}",
                                "source": current_chain_parent,
                                "target": node_id,
                                "className": "branch-edge"
                            })
                        elif last_tx_node_id:
                             rf_edges.append({
                                "id": f"e_{last_tx_node_id}_{node_id}",
                                "source": last_tx_node_id,
                                "target": node_id,
                                "className": "vertical-edge"
                            })
                        last_tx_node_id = node_id
                    
                    current_chain_parent = last_tx_node_id

                # Handle children recursively
                children = node.get('children', {})
                child_list = list(children.values()) if isinstance(children, dict) else children
                if child_list:
                    # Calculate child_y based on the vertical span of the current node's transactions
                    child_y_start = node_y + (max(1, len(txs)) * 160) + 100
                    # For a more uniform tree look, we can also use a fixed level increment if it's large enough,
                    # but dynamic is safer. Let's use max(450, calculated_y) for consistency.
                    next_y = max(y_offset + 450, child_y_start)
                    traverse(child_list, current_chain_parent, level + 1, node_x, next_y)



        traverse(nodes, parent_id)
        return {"nodes": rf_nodes, "edges": rf_edges}


    def find_survey_timeline(self, hierarchy_data: List[Dict[str, Any]], target_sn: str, limit: Optional[int] = None, doc_map: Dict[str, str] = None, source_docs_dir: str = None) -> Dict[str, Any]:
        """Finds a specific survey number and its lineage in the tree."""
        target_norm = self._normalize_sn(target_sn)
        
        # 1. First, find all transactions in the entire subtree to apply the global limit
        all_potential_txs = []
        def find_node_and_collect(nodes, current_path):
            for node in nodes:
                sn_norm = self._normalize_sn(node.get('survey_number'))
                new_path = current_path + [node.get('survey_number')]
                
                if sn_norm == target_norm:
                    # Recursive collection for sub-tree
                    subtree_txs = []
                    def collect_all_recursive(n):
                        for t in n.get('transactions', []):
                            tx_c = t.copy()
                            tx_c['survey_number'] = n.get('survey_number')
                            subtree_txs.append(tx_c)
                        children = n.get('children', {})
                        child_list = list(children.values()) if isinstance(children, dict) else children
                        for c in child_list: collect_all_recursive(c)
                    
                    collect_all_recursive(node)
                    return node, new_path, subtree_txs
                
                children = node.get('children', {})
                child_list = list(children.values()) if isinstance(children, dict) else children
                res = find_node_and_collect(child_list, new_path)
                if res: return res
            return None

        search_res = find_node_and_collect(hierarchy_data, [])
        if not search_res:
             return {"found": False, "message": f"Survey number {target_sn} not found in validated hierarchy."}

        target_node, lineage_path, all_txs = search_res

        # 2. Extract Pruned Lineage Path Tree (Ancestors + Targeted Subtree)
        def get_pruned_lineage(nodes, target_n):
            for node in nodes:
                sn_norm = self._normalize_sn(node.get('survey_number'))
                if sn_norm == target_n:
                    return node # Keep full subtree of target
                
                children = node.get('children', {})
                child_list = list(children.values()) if isinstance(children, dict) else children
                lineage_child = get_pruned_lineage(child_list, target_n)
                if lineage_child:
                    # Found target in this branch, return pruned version of ancestor
                    return {
                        **node,
                        "children": {lineage_child.get('survey_number'): lineage_child},
                        "transactions": node.get('transactions', []) # Keep ancestor transactions for context
                    }
            return None

        pruned_tree = get_pruned_lineage(hierarchy_data, target_norm)

        # 3. Apply Limit to Transactions
        all_txs.sort(key=lambda x: self._parse_date_for_sort(x.get('date', '')), reverse=False)
        allowed_docs = None
        if limit and limit > 0:
            allowed_docs = set(t.get('document_number') for t in all_txs[-limit:])
            all_txs = all_txs[-limit:]
        
        # Add PDF URLs and styles for history list
        for tx in all_txs:
            doc_no = tx.get('document_number')
            nat = (tx.get('nature') or tx.get('nature_of_document', '')).lower()
            
            # Determine style
            style = "base-node"
            if any(x in nat for x in ['sale', 'conveyance', 'kraya', 'விற்பனை', 'கிரைய']): style = "sale-node"
            elif any(x in nat for x in ['mortgage', 'hypothecation', 'adamanam', 'அடமான']): style = "mortgage-node"
            elif any(x in nat for x in ['gift', 'dhana', 'தான', 'செட்டில்மெண்ட்']): style = "gift-node"
            elif 'settlement' in nat: style = "settlement-node"
            elif any(x in nat for x in ['release', 'viduthalai', 'விடுதலை']): style = "release-node"
            elif any(x in nat for x in ['partition', 'baaga', 'பாக']): style = "partition-node"
            elif any(x in nat for x in ['power of attorney', 'aathara', 'அதிகார']): style = "power-node"
            
            tx['className'] = style
            if doc_map and doc_no in doc_map:
                tx['pdf_url'] = doc_map[doc_no]

        # 4. Generate React Flow Data using pruned tree and transaction whitelist
        self.node_counter = 0
        rf_data = self._generate_react_flow_data([pruned_tree] if pruned_tree else [], doc_map=doc_map, allowed_docs=allowed_docs)

        return {
            "found": True,
            "survey_number": target_sn,
            "lineage_path": lineage_path,
            "all_transactions": all_txs,
            "first_transaction": all_txs[0] if all_txs else None,
            "last_transaction": all_txs[-1] if all_txs else None,
            "react_flow_data": rf_data,
            "doc_map": doc_map
        }

    def process(self, ec_pdf_path: str, matched_docs: List[Dict[str, Any]] = None, source_docs_dir: str = None, limit: Optional[int] = None):
        ec_final_path = os.path.join(self.output_dir, "ec_final.json")
        raw_text_path = os.path.join(self.output_dir, "ec_raw_full.txt")
        
        hierarchy_data = []
        
        # PRIMARY OPTIMIZATION: Skip LLM if EC is already parsed
        if os.path.exists(ec_final_path):
            yield "Building hierarchy from extracted data (Skipping LLM)..."
            try:
                with open(ec_final_path, 'r', encoding='utf-8') as f:
                    flat_data = json.load(f)
                hierarchy_data = self.build_hierarchy_programmatically(flat_data)
            except Exception as e:
                yield f"Programmatic build failed: {e}. Falling back to text-based..."

        # SECONDARY OPTIMIZATION: Reuse raw text if available
        if not hierarchy_data:
            yield "Extracting lineage structure..."
            text = ""
            if os.path.exists(raw_text_path):
                yield "Reusing extracted EC text..."
                with open(raw_text_path, 'r', encoding='utf-8') as f:
                    text = f.read()
            
            if not text:
                text = self.extract_text(ec_pdf_path)
            
            try:
                hierarchy_data = self.get_hierarchy_data(text)
            except Exception as e:
                yield f"LLM error: {e}"

        # FALLBACK: If LLM failed or returned nothing
        if not hierarchy_data and os.path.exists(ec_final_path):
            yield "Reading fallback data..."
            with open(ec_final_path, 'r', encoding='utf-8') as f:
                flat_data = json.load(f)
            hierarchy_data = self.build_hierarchy_programmatically(flat_data)
        
        if hierarchy_data:
            yield "Applying Hierarchy Logic (Mother -> Child -> Grandchild)..."
            hierarchy_data = self._repair_hierarchy_data(hierarchy_data)
        
        if not hierarchy_data:
            yield "No data available."
            return []

        json_path = os.path.join(self.output_dir, "hierarchy_tree.json")
        with open(json_path, "w", encoding="utf-8") as f:
            json.dump(hierarchy_data, f, indent=2, ensure_ascii=False)
        
        html_path = os.path.join(self.output_dir, "hierarchy_view.html")
        self.generate_visual_html(hierarchy_data, html_path, matched_docs=matched_docs, source_docs_dir=source_docs_dir, limit=limit)
        yield f"Lineage view generated: {html_path}"
        return hierarchy_data
