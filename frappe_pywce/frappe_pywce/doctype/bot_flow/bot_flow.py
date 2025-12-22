# Copyright (c) 2025, donnc and contributors
# For license information, please see license.txt

import frappe
from frappe.model.document import Document
import json


class BotFlow(Document):
    def before_save(self):
        """Set metadata before saving"""
        if not self.created_by:
            self.created_by = frappe.session.user
        self.last_modified = frappe.utils.now()

    def validate(self):
        """Validate flow JSON structure"""
        if self.flow_json:
            try:
                if isinstance(self.flow_json, str):
                    json.loads(self.flow_json)
            except json.JSONDecodeError:
                frappe.throw("Invalid JSON format in Flow JSON field")


@frappe.whitelist()
def duplicate_flow(source_name, new_name):
    """Duplicate a flow with a new name"""
    if frappe.db.exists("Bot Flow", new_name):
        frappe.throw(f"Flow with name '{new_name}' already exists")

    # Get source document
    source_doc = frappe.get_doc("Bot Flow", source_name)
    
    # Create new document
    new_doc = frappe.copy_doc(source_doc)
    new_doc.flow_name = new_name
    new_doc.created_by = frappe.session.user
    new_doc.last_modified = frappe.utils.now()
    new_doc.insert()

    return new_doc.name


@frappe.whitelist()
def export_flow(flow_name):
    """Export flow as JSON"""
    doc = frappe.get_doc("Bot Flow", flow_name)
    
    return {
        "flow_name": doc.flow_name,
        "description": doc.description,
        "flow_type": doc.flow_type,
        "flow_json": doc.flow_json,
        "is_active": doc.is_active,
        "exported_at": frappe.utils.now(),
        "exported_by": frappe.session.user,
    }


@frappe.whitelist()
def import_flow(flow_data):
    """Import a flow from JSON data"""
    try:
        if isinstance(flow_data, str):
            flow_data = json.loads(flow_data)

        # Check if flow already exists
        flow_name = flow_data.get("flow_name")
        if frappe.db.exists("Bot Flow", flow_name):
            frappe.throw(f"Flow '{flow_name}' already exists. Please rename before importing.")

        # Create new flow
        doc = frappe.get_doc(
            {
                "doctype": "Bot Flow",
                "flow_name": flow_name,
                "description": flow_data.get("description"),
                "flow_type": flow_data.get("flow_type"),
                "flow_json": flow_data.get("flow_json"),
                "is_active": flow_data.get("is_active", 1),
            }
        )
        doc.insert()

        return doc.name

    except Exception as e:
        frappe.throw(f"Error importing flow: {str(e)}")


@frappe.whitelist()
def get_all_active_flows():
    """Get all active flows"""
    return frappe.get_all(
        "Bot Flow",
        filters={"is_active": 1},
        fields=["name", "flow_name", "description", "flow_type", "flow_json"],
        order_by="modified desc",
    )


@frappe.whitelist()
def get_flow_by_name(flow_name):
    """Get a specific flow by name"""
    if not frappe.db.exists("Bot Flow", flow_name):
        frappe.throw(f"Flow '{flow_name}' not found")

    return frappe.get_doc("Bot Flow", flow_name).as_dict()