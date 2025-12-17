// your_app/frappe_pywce/page/whatsapp/whatsapp.js

frappe.pages['whatsapp'].on_page_load = function(wrapper) {
    var page = frappe.ui.make_app_page({
        parent: wrapper,
        title: 'WhatsApp',
        single_column: true
    });

    let whatsapp = new WhatsAppInterface(page);
    whatsapp.init();
};

class WhatsAppInterface {
    constructor(page) {
        this.page = page;
        this.current_contact = null;
        this.contacts = [];
        this.messages = [];
        this.chatbot_config = null;
    }

    init() {
        this.setup_page();
        this.load_config();
        this.load_contacts();
        this.setup_realtime();
        this.setup_event_listeners();
    }

    setup_page() {
        $(this.page.body).html(frappe.render_template("whatsapp"));
    }

    async load_config() {
        try {
            const response = await frappe.call({
                method: 'frappe_pywce.api.whatsapp_api.get_chatbot_config'
            });

            this.chatbot_config = response.message;
            
            if (!this.chatbot_config.is_configured) {
                frappe.msgprint({
                    title: __('Configuration Required'),
                    message: __('Please configure ChatBot Config with Access Token and Phone ID first.'),
                    indicator: 'red'
                });
            }
        } catch (error) {
            console.error('Error loading config:', error);
        }
    }

    setup_event_listeners() {
        // Contact search
        $('#contact-search').on('input', (e) => {
            this.search_contacts(e.target.value);
        });

        // Send message
        $('#send-btn').on('click', () => this.send_message());
        
        $('#message-input').on('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this.send_message();
            }
        });

        // Auto-resize textarea
        $('#message-input').on('input', function() {
            this.style.height = 'auto';
            this.style.height = (this.scrollHeight) + 'px';
        });

        // Attach file
        $('#attach-btn').on('click', () => {
            $('#file-input').click();
        });

        $('#file-input').on('change', (e) => {
            this.handle_file_upload(e.target.files[0]);
        });

        // New chat button
        $('#new-chat-btn').on('click', () => {
            this.new_chat_dialog();
        });

        // Settings button
        $('#settings-btn').on('click', () => {
            frappe.set_route('Form', 'ChatBot Config', 'ChatBot Config');
        });
    }

    async load_contacts() {
        try {
            const response = await frappe.call({
                method: 'frappe_pywce.api.whatsapp_api.get_contacts'
            });

            this.contacts = response.message || [];
            this.render_contacts();
        } catch (error) {
            console.error('Error loading contacts:', error);
            frappe.msgprint(__('Failed to load contacts'));
        }
    }

    render_contacts(filter_query = '') {
        const contacts_list = $('#contacts-list');
        contacts_list.empty();

        let filtered_contacts = this.contacts;
        if (filter_query) {
            filtered_contacts = this.contacts.filter(c => 
                (c.contact_name && c.contact_name.toLowerCase().includes(filter_query.toLowerCase())) ||
                c.phone_number.includes(filter_query)
            );
        }

        if (filtered_contacts.length === 0) {
            contacts_list.html('<div style="padding: 20px; text-align: center; color: #667781;">No contacts found</div>');
            return;
        }

        filtered_contacts.forEach(contact => {
            const contact_html = `
                <div class="contact-item ${this.current_contact === contact.name ? 'active' : ''}" data-contact="${contact.name}">
                    <img src="${contact.profile_pic || '/assets/frappe/images/default-avatar.png'}" 
                         alt="${contact.contact_name}" 
                         class="contact-avatar">
                    <div class="contact-details">
                        <div class="contact-name">${contact.contact_name || contact.phone_number}</div>
                        <div class="contact-last-message">${this.truncate_text(contact.last_message || '', 40)}</div>
                    </div>
                    <div class="contact-meta">
                        <div class="contact-time">${this.format_time(contact.last_message_time)}</div>
                        ${contact.unread_count > 0 ? `<span class="unread-badge">${contact.unread_count}</span>` : ''}
                    </div>
                </div>
            `;
            contacts_list.append(contact_html);
        });

        // Add click handlers
        $('.contact-item').on('click', (e) => {
            const contact = $(e.currentTarget).data('contact');
            this.open_chat(contact);
        });
    }

    async open_chat(contact) {
        this.current_contact = contact;
        
        // Update UI
        $('.contact-item').removeClass('active');
        $(`.contact-item[data-contact="${contact}"]`).addClass('active');
        
        $('#chat-placeholder').hide();
        $('#chat-container').show();

        // Load contact details
        const contact_data = this.contacts.find(c => c.name === contact);
        if (contact_data) {
            $('#chat-contact-name').text(contact_data.contact_name || contact_data.phone_number);
            $('#chat-contact-phone').text(contact_data.phone_number);
            $('#chat-avatar').attr('src', contact_data.profile_pic || '/assets/frappe/images/default-avatar.png');
        }

        // Load messages
        await this.load_messages(contact);
        
        // Mark as read
        this.mark_as_read(contact);
    }

    async load_messages(contact) {
        try {
            const response = await frappe.call({
                method: 'frappe_pywce.api.whatsapp_api.get_messages',
                args: { contact: contact }
            });

            this.messages = response.message || [];
            this.render_messages();
        } catch (error) {
            console.error('Error loading messages:', error);
        }
    }

    render_messages() {
        const container = $('#messages-container');
        container.empty();

        this.messages.forEach(message => {
            const message_html = this.create_message_html(message);
            container.append(message_html);
        });

        // Scroll to bottom
        container.scrollTop(container[0].scrollHeight);
    }

    create_message_html(message) {
        const is_outbound = message.direction === 'Outbound';
        const time = this.format_message_time(message.timestamp);
        
        let content = '';
        if (message.message_type === 'text') {
            content = `<p class="message-text">${this.escape_html(message.message_text)}</p>`;
        } else if (['image', 'video', 'audio', 'document'].includes(message.message_type)) {
            content = this.create_media_html(message);
        }

        const status_icon = is_outbound ? this.get_status_icon(message.status) : '';

        return `
            <div class="message ${is_outbound ? 'outbound' : 'inbound'}">
                <div class="message-bubble">
                    ${content}
                    <div class="message-time">
                        ${time}
                        ${status_icon}
                    </div>
                </div>
            </div>
        `;
    }

    create_media_html(message) {
        const caption = message.media_caption ? `<p class="message-text">${this.escape_html(message.media_caption)}</p>` : '';
        
        if (message.message_type === 'image') {
            return `<div class="media-message"><img src="${message.media_url}" alt="Image">${caption}</div>`;
        } else if (message.message_type === 'video') {
            return `<div class="media-message"><video src="${message.media_url}" controls></video>${caption}</div>`;
        } else if (message.message_type === 'audio') {
            return `<div class="media-message"><audio src="${message.media_url}" controls></audio>${caption}</div>`;
        } else {
            return `<div class="media-message"><a href="${message.media_url}" target="_blank"><i class="fa fa-file"></i> Document</a>${caption}</div>`;
        }
    }

    async send_message() {
        const input = $('#message-input');
        const message_text = input.val().trim();

        if (!message_text || !this.current_contact) return;

        try {
            // Disable input
            input.prop('disabled', true);
            $('#send-btn').prop('disabled', true);

            const response = await frappe.call({
                method: 'frappe_pywce.api.whatsapp_api.send_message',
                args: {
                    phone_number: this.current_contact,
                    message_text: message_text,
                    message_type: 'text'
                }
            });

            // Clear input
            input.val('').css('height', 'auto');

            // Add message to UI
            if (response.message && response.message.message) {
                this.messages.push(response.message.message);
                const message_html = this.create_message_html(response.message.message);
                $('#messages-container').append(message_html);
                $('#messages-container').scrollTop($('#messages-container')[0].scrollHeight);
            }

            // Update contact list
            this.load_contacts();

        } catch (error) {
            console.error('Error sending message:', error);
            frappe.msgprint(__('Failed to send message'));
        } finally {
            input.prop('disabled', false);
            $('#send-btn').prop('disabled', false);
            input.focus();
        }
    }

    async mark_as_read(contact) {
        try {
            await frappe.call({
                method: 'frappe_pywce.api.whatsapp_api.mark_as_read',
                args: { contact: contact }
            });

            // Update contact in list
            const contact_data = this.contacts.find(c => c.name === contact);
            if (contact_data) {
                contact_data.unread_count = 0;
                this.render_contacts();
            }
        } catch (error) {
            console.error('Error marking as read:', error);
        }
    }

    setup_realtime() {
        // Listen for incoming messages
        frappe.realtime.on('whatsapp_message_received', (data) => {
            console.log('Message received:', data);
            
            // Update contacts list
            this.load_contacts();

            // If chat is open with this contact, add message
            if (this.current_contact === data.contact) {
                this.messages.push(data.message);
                const message_html = this.create_message_html(data.message);
                $('#messages-container').append(message_html);
                $('#messages-container').scrollTop($('#messages-container')[0].scrollHeight);
                
                // Mark as read
                this.mark_as_read(data.contact);
            } else {
                // Show notification
                frappe.show_alert({
                    message: __('New message from {0}', [data.contact]),
                    indicator: 'green'
                });
            }
        });

        // Listen for message status updates
        frappe.realtime.on('whatsapp_message_status', (data) => {
            console.log('Status update:', data);
            
            // Update message status in UI
            const message = this.messages.find(m => m.message_id === data.message_id);
            if (message) {
                message.status = data.status;
                this.render_messages();
            }
        });
    }

    async handle_file_upload(file) {
        if (!file || !this.current_contact) return;

        try {
            frappe.show_alert({
                message: __('Uploading file...'),
                indicator: 'blue'
            });

            // Upload file to Frappe
            const form_data = new FormData();
            form_data.append('file', file);
            form_data.append('is_private', 1);

            const upload_response = await fetch('/api/method/upload_file', {
                method: 'POST',
                headers: {
                    'X-Frappe-CSRF-Token': frappe.csrf_token
                },
                body: form_data
            });

            const upload_data = await upload_response.json();
            const file_url = upload_data.message.file_url;

            // Determine message type
            let message_type = 'document';
            if (file.type.startsWith('image/')) message_type = 'image';
            else if (file.type.startsWith('video/')) message_type = 'video';
            else if (file.type.startsWith('audio/')) message_type = 'audio';

            // Send via WhatsApp
            await frappe.call({
                method: 'frappe_pywce.api.whatsapp_api.send_message',
                args: {
                    phone_number: this.current_contact,
                    message_text: '',
                    message_type: message_type,
                    media_url: window.location.origin + file_url
                }
            });

            frappe.show_alert({
                message: __('File sent successfully'),
                indicator: 'green'
            });

            this.load_messages(this.current_contact);

        } catch (error) {
            console.error('Error uploading file:', error);
            frappe.msgprint(__('Failed to send file'));
        }
    }

    new_chat_dialog() {
        const dialog = new frappe.ui.Dialog({
            title: __('New Chat'),
            fields: [
                {
                    fieldname: 'phone_number',
                    fieldtype: 'Data',
                    label: __('Phone Number'),
                    reqd: 1,
                    description: __('Enter phone number with country code (e.g., +1234567890)')
                },
                {
                    fieldname: 'contact_name',
                    fieldtype: 'Data',
                    label: __('Contact Name')
                }
            ],
            primary_action_label: __('Start Chat'),
            primary_action: async (values) => {
                try {
                    // Create contact if doesn't exist
                    if (!frappe.db.exists('WhatsApp Contact', values.phone_number)) {
                        await frappe.call({
                            method: 'frappe.client.insert',
                            args: {
                                doc: {
                                    doctype: 'WhatsApp Contact',
                                    phone_number: values.phone_number,
                                    contact_name: values.contact_name || values.phone_number
                                }
                            }
                        });
                    }

                    dialog.hide();
                    await this.load_contacts();
                    this.open_chat(values.phone_number);

                } catch (error) {
                    console.error('Error creating contact:', error);
                    frappe.msgprint(__('Failed to create contact'));
                }
            }
        });

        dialog.show();
    }

    search_contacts(query) {
        this.render_contacts(query);
    }

    // Helper functions
    format_time(timestamp) {
        if (!timestamp) return '';
        const date = new Date(timestamp);
        const now = new Date();
        const diff = now - date;
        
        if (diff < 86400000) { // Less than 24 hours
            return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
        } else if (diff < 604800000) { // Less than 7 days
            return date.toLocaleDateString('en-US', { weekday: 'short' });
        } else {
            return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        }
    }

    format_message_time(timestamp) {
        if (!timestamp) return '';
        const date = new Date(timestamp);
        return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    }

    get_status_icon(status) {
        const icons = {
            'sent': '<i class="fa fa-check message-status"></i>',
            'delivered': '<i class="fa fa-check-double message-status delivered"></i>',
            'read': '<i class="fa fa-check-double message-status read"></i>',
            'failed': '<i class="fa fa-exclamation-circle" style="color: red;"></i>'
        };
        return icons[status] || '';
    }

    truncate_text(text, length) {
        if (!text) return '';
        return text.length > length ? text.substring(0, length) + '...' : text;
    }

    escape_html(text) {
        if (!text) return '';
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;')
            .replace(/\n/g, '<br>');
    }
}