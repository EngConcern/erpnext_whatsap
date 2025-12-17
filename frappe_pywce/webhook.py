import json
from datetime import datetime

import redis
import redis.exceptions

import frappe
import frappe.utils

from frappe_pywce.config import get_engine_config, get_wa_config
from frappe_pywce.util import CACHE_KEY_PREFIX, LOCK_WAIT_TIME, LOCK_LEASE_TIME, bot_settings, create_cache_key
from frappe_pywce.pywce_logger import app_logger as logger


def _verifier():
    """
        Verify WhatsApp webhook callback URL challenge.

        Ref:    https://discuss.frappe.io/t/returning-plain-text-from-whitelisted-method/32621
    """
    params = frappe.request.args

    mode, token, challenge = params.get("hub.mode"), params.get("hub.verify_token"), params.get("hub.challenge")

    if get_wa_config(bot_settings()).util.webhook_challenge(mode, challenge, token):
        from werkzeug.wrappers import Response
        return Response(challenge)

    frappe.throw("Webhook verification challenge failed", exc=frappe.PermissionError)


def _save_incoming_message(payload: dict):
    """
    Save incoming WhatsApp message to database for chat interface
    
    Args:
        payload (dict): WhatsApp webhook payload
    """
    try:
        # Extract message from payload
        if not payload.get('entry'):
            return
        
        for entry in payload.get('entry', []):
            for change in entry.get('changes', []):
                value = change.get('value', {})
                messages = value.get('messages', [])
                
                for message in messages:
                    # Normalize phone number - remove all non-numeric characters
                    raw_phone = message.get('from', '')
                    phone_number = ''.join(filter(str.isdigit, raw_phone))
                    
                    message_id = message.get('id', '')
                    timestamp = message.get('timestamp')
                    message_type = message.get('type', 'text')
                    
                    # Get message text based on type
                    message_text = ''
                    media_url = None
                    media_type = None
                    
                    if message_type == 'text':
                        message_text = message.get('text', {}).get('body', '')
                    
                    elif message_type == 'image':
                        image_data = message.get('image', {})
                        message_text = image_data.get('caption', '')
                        media_url = image_data.get('id', '')
                        media_type = 'image'
                    
                    elif message_type == 'video':
                        video_data = message.get('video', {})
                        message_text = video_data.get('caption', '')
                        media_url = video_data.get('id', '')
                        media_type = 'video'
                    
                    elif message_type == 'audio':
                        audio_data = message.get('audio', {})
                        media_url = audio_data.get('id', '')
                        media_type = 'audio'
                        message_text = f"Audio message ({audio_data.get('mime_type', 'audio')})"
                    
                    elif message_type == 'voice':
                        voice_data = message.get('voice', {})
                        media_url = voice_data.get('id', '')
                        media_type = 'voice'
                        message_text = "Voice message"
                    
                    elif message_type == 'document':
                        doc_data = message.get('document', {})
                        message_text = doc_data.get('filename', 'Document')
                        media_url = doc_data.get('id', '')
                        media_type = 'document'
                    
                    elif message_type == 'sticker':
                        sticker_data = message.get('sticker', {})
                        media_url = sticker_data.get('id', '')
                        media_type = 'sticker'
                        message_text = "Sticker"
                    
                    elif message_type == 'location':
                        location_data = message.get('location', {})
                        message_text = f"Location: {location_data.get('name', 'Shared location')}"
                    
                    elif message_type == 'contacts':
                        contacts_data = message.get('contacts', [])
                        if contacts_data:
                            contact = contacts_data[0]
                            name = contact.get('name', {}).get('formatted_name', 'Contact')
                            message_text = f"Contact: {name}"
                    
                    elif message_type == 'button':
                        button_data = message.get('button', {})
                        message_text = f"Button: {button_data.get('text', 'Button clicked')}"
                    
                    elif message_type == 'interactive':
                        interactive_data = message.get('interactive', {})
                        interactive_type = interactive_data.get('type', '')
                        
                        if interactive_type == 'button_reply':
                            button_reply = interactive_data.get('button_reply', {})
                            message_text = f"Button: {button_reply.get('title', 'Button clicked')}"
                        elif interactive_type == 'list_reply':
                            list_reply = interactive_data.get('list_reply', {})
                            message_text = f"Selected: {list_reply.get('title', 'List item')}"
                        else:
                            message_text = "Interactive message"
                    
                    else:
                        message_text = f"Unsupported message type: {message_type}"
                    
                    # Get contact name from contacts in payload
                    contact_name = ''
                    contacts = value.get('contacts', [])
                    for contact in contacts:
                        contact_wa_id = ''.join(filter(str.isdigit, contact.get('wa_id', '')))
                        if contact_wa_id == phone_number:
                            profile = contact.get('profile', {})
                            contact_name = profile.get('name', '')
                            break
                    
                    # Check if message already exists
                    existing = frappe.db.exists('WhatsApp Chat Message', {'message_id': message_id})
                    if existing:
                        continue
                    
                    # Create message document
                    msg_doc = frappe.get_doc({
                        "doctype": "WhatsApp Chat Message",
                        "phone_number": phone_number,
                        "message_id": message_id,
                        "timestamp": datetime.fromtimestamp(int(timestamp)) if timestamp else datetime.now(),
                        "direction": "Incoming",
                        "message_type": message_type,
                        "message_text": message_text,
                        "media_url": media_url,
                        "media_type": media_type,
                        "contact_name": contact_name,
                        "status": "delivered",
                        "metadata": json.dumps(message)
                    })
                    msg_doc.insert(ignore_permissions=True)
                    
                    # Publish realtime event for chat interface
                    frappe.publish_realtime(
                        event='whatsapp_message_received',
                        message={
                            'phone_number': phone_number,
                            'message_id': message_id,
                            'message_text': message_text
                        },
                        after_commit=True
                    )
                    
                    logger.info(f"Saved incoming message from {phone_number}: {message_id}")
        
        frappe.db.commit()
        
    except Exception as e:
        logger.error(f"Error saving incoming message: {str(e)}")
        frappe.log_error(title="WhatsApp Chat Message Save Error", message=str(e))


def _save_message_status(payload: dict):
    """
    Update message status from webhook status updates
    
    Args:
        payload (dict): WhatsApp webhook payload
    """
    try:
        if not payload.get('entry'):
            return
        
        for entry in payload.get('entry', []):
            for change in entry.get('changes', []):
                value = change.get('value', {})
                statuses = value.get('statuses', [])
                
                for status in statuses:
                    message_id = status.get('id', '')
                    new_status = status.get('status', '')
                    
                    # Map WhatsApp status to our status
                    status_map = {
                        'sent': 'sent',
                        'delivered': 'delivered',
                        'read': 'read',
                        'failed': 'failed'
                    }
                    
                    mapped_status = status_map.get(new_status, 'sent')
                    
                    # Update message status
                    frappe.db.set_value(
                        'WhatsApp Chat Message',
                        {'message_id': message_id},
                        'status',
                        mapped_status
                    )
                    
                    logger.info(f"Updated message status: {message_id} -> {mapped_status}")
        
        frappe.db.commit()
        
    except Exception as e:
        logger.error(f"Error updating message status: {str(e)}")
        frappe.log_error(title="WhatsApp Message Status Update Error", message=str(e))


def _internal_webhook_handler(wa_id: str, payload: dict):
    """Process webhook data internally

    Args:
        wa_id (str): WhatsApp user ID
        payload (dict): webhook raw payload data to process
    """
    try:
        lock_key = create_cache_key(f"lock:{wa_id}")
        
        with frappe.cache().lock(lock_key, timeout=LOCK_LEASE_TIME, blocking_timeout=LOCK_WAIT_TIME):
            # Save incoming messages to chat database
            _save_incoming_message(payload)
            
            # Update message statuses
            _save_message_status(payload)
            
            # Process with existing engine
            get_engine_config().process_webhook(payload)

    except redis.exceptions.LockError:
        logger.critical("FIFO Enforcement: Dropped concurrent message for %s due to lock error.", wa_id)

    except Exception:
        frappe.log_error(title="Chatbot Webhook E.Handler")


def _on_job_success(*args, **kwargs):
    logger.debug("Webhook job completed successfully, args: %s, kwargs %s", args, kwargs)


def _on_job_error(*args, **kwargs):
    logger.debug("Webhook job failed, args: %s, kwargs %s", args, kwargs)


def _handle_webhook():
    payload = frappe.request.data

    try:
        payload_dict = json.loads(payload.decode('utf-8'))
    except json.JSONDecodeError:
        frappe.throw("Invalid webhook data", exc=frappe.ValidationError)

    should_run_in_bg = frappe.db.get_single_value("ChatBot Config", "process_in_background")

    wa_user = get_wa_config(bot_settings()).util.get_wa_user(payload_dict)

    if wa_user is None:
        return "Invalid user"
    
    job_id = f"{wa_user.wa_id}:{wa_user.msg_id}"
    
    logger.debug("Starting a new webhook job id: %s", job_id)

    frappe.enqueue(
        _internal_webhook_handler,
        now=should_run_in_bg == 0,

        payload=payload_dict,
        wa_id=wa_user.wa_id,

        job_id=create_cache_key(job_id),
        on_success=_on_job_success,
        on_failure=_on_job_error
    )

    return "OK"


@frappe.whitelist()
def get_webhook():
    return frappe.utils.get_request_site_address() + '/api/method/frappe_pywce.webhook.webhook'


@frappe.whitelist()
def clear_session():
    frappe.cache.delete_keys(CACHE_KEY_PREFIX)


@frappe.whitelist(allow_guest=True, methods=["GET", "POST"])
def webhook():
    if frappe.request.method == 'GET':
        return _verifier()
    
    if frappe.request.method == 'POST':
        return _handle_webhook()
    
    frappe.throw("Forbidden method", exc=frappe.PermissionError)