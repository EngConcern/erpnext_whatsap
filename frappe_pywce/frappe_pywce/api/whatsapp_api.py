# your_app/frappe_pywce/api/whatsapp_api.py

import frappe
import requests
import json
from frappe import _
from datetime import datetime

@frappe.whitelist()
def get_contacts():
    """Get all WhatsApp contacts"""
    contacts = frappe.get_all(
        "WhatsApp Contact",
        fields=["name", "phone_number", "contact_name", "profile_pic", 
                "last_message", "last_message_time", "unread_count"],
        order_by="last_message_time desc"
    )
    return contacts

@frappe.whitelist()
def get_messages(contact):
    """Get all messages for a specific contact"""
    messages = frappe.get_all(
        "WhatsApp Message",
        filters={"contact": contact},
        fields=["name", "message_id", "direction", "message_type", "message_text", 
                "media_url", "media_caption", "status", "timestamp", "is_read"],
        order_by="timestamp asc"
    )
    return messages

@frappe.whitelist()
def send_message(phone_number, message_text, message_type="text", media_url=None):
    """Send a WhatsApp message via Meta API"""
    try:
        # Get ChatBot Config settings
        config = frappe.get_single("ChatBot Config")
        
        if not config.access_token or not config.phone_id:
            frappe.throw(_("ChatBot Config not properly configured. Please set Access Token and Phone ID"))
        
        # Ensure contact exists
        contact = get_or_create_contact(phone_number)
        
        # Prepare API request
        url = f"https://graph.facebook.com/v18.0/{config.phone_id}/messages"
        headers = {
            "Authorization": f"Bearer {config.access_token}",
            "Content-Type": "application/json"
        }
        
        # Build message payload
        payload = {
            "messaging_product": "whatsapp",
            "recipient_type": "individual",
            "to": phone_number
        }
        
        if message_type == "text":
            payload["type"] = "text"
            payload["text"] = {"body": message_text}
        elif message_type in ["image", "video", "audio", "document"]:
            payload["type"] = message_type
            payload[message_type] = {
                "link": media_url
            }
            if message_text:
                payload[message_type]["caption"] = message_text
        
        # Send request to WhatsApp API
        response = requests.post(url, headers=headers, json=payload)
        response.raise_for_status()
        
        result = response.json()
        message_id = result.get("messages", [{}])[0].get("id")
        
        # Save message to database
        message_doc = frappe.get_doc({
            "doctype": "WhatsApp Message",
            "contact": contact,
            "message_id": message_id,
            "direction": "Outbound",
            "message_type": message_type,
            "message_text": message_text,
            "media_url": media_url,
            "status": "sent",
            "timestamp": datetime.now()
        })
        message_doc.insert(ignore_permissions=True)
        
        # Update contact's last message
        update_contact_last_message(contact, message_text, datetime.now())
        
        # Publish real-time update
        frappe.publish_realtime(
            "whatsapp_message_sent",
            {"contact": contact, "message": message_doc.as_dict()},
            user=frappe.session.user
        )
        
        return {
            "success": True,
            "message_id": message_id,
            "message": message_doc.as_dict()
        }
        
    except requests.exceptions.RequestException as e:
        frappe.log_error(f"WhatsApp API Error: {str(e)}", "WhatsApp Send Message")
        frappe.throw(_("Failed to send message: {0}").format(str(e)))
    except Exception as e:
        frappe.log_error(f"Error sending WhatsApp message: {str(e)}", "WhatsApp Send Message")
        frappe.throw(_("An error occurred: {0}").format(str(e)))

@frappe.whitelist()
def mark_as_read(contact):
    """Mark all messages from a contact as read"""
    messages = frappe.get_all(
        "WhatsApp Message",
        filters={
            "contact": contact,
            "direction": "Inbound",
            "is_read": 0
        },
        pluck="name"
    )
    
    for message in messages:
        doc = frappe.get_doc("WhatsApp Message", message)
        doc.is_read = 1
        doc.read_at = datetime.now()
        doc.save(ignore_permissions=True)
    
    # Update unread count
    contact_doc = frappe.get_doc("WhatsApp Contact", contact)
    contact_doc.unread_count = 0
    contact_doc.save(ignore_permissions=True)
    
    return {"success": True}

def get_or_create_contact(phone_number, contact_name=None):
    """Get existing contact or create new one"""
    if frappe.db.exists("WhatsApp Contact", phone_number):
        return phone_number
    
    contact = frappe.get_doc({
        "doctype": "WhatsApp Contact",
        "phone_number": phone_number,
        "contact_name": contact_name or phone_number
    })
    contact.insert(ignore_permissions=True)
    return contact.name

def update_contact_last_message(contact, message, timestamp):
    """Update contact's last message info"""
    contact_doc = frappe.get_doc("WhatsApp Contact", contact)
    contact_doc.last_message = message[:100] if message else ""
    contact_doc.last_message_time = timestamp
    contact_doc.save(ignore_permissions=True)

@frappe.whitelist()
def upload_media(file_data):
    """Upload media to WhatsApp and return media ID"""
    try:
        config = frappe.get_single("ChatBot Config")
        
        url = f"https://graph.facebook.com/v18.0/{config.phone_id}/media"
        headers = {
            "Authorization": f"Bearer {config.access_token}"
        }
        
        files = {
            "file": file_data,
            "messaging_product": "whatsapp"
        }
        
        response = requests.post(url, headers=headers, files=files)
        response.raise_for_status()
        
        result = response.json()
        return {"success": True, "media_id": result.get("id")}
        
    except Exception as e:
        frappe.log_error(f"Media upload error: {str(e)}", "WhatsApp Media Upload")
        frappe.throw(_("Failed to upload media: {0}").format(str(e)))

@frappe.whitelist()
def search_contacts(query):
    """Search contacts by name or phone number"""
    contacts = frappe.get_all(
        "WhatsApp Contact",
        filters=[
            ["contact_name", "like", f"%{query}%"],
            "or",
            ["phone_number", "like", f"%{query}%"]
        ],
        fields=["name", "phone_number", "contact_name", "profile_pic"],
        limit=20
    )
    return contacts

@frappe.whitelist()
def get_chatbot_config():
    """Get ChatBot configuration details"""
    config = frappe.get_single("ChatBot Config")
    return {
        "chatbot_name": config.chatbot_name,
        "chatbot_mobile_number": config.chatbot_mobile_number,
        "env": config.env,
        "is_configured": bool(config.access_token and config.phone_id)
    }