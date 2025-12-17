frappe.pages['whatsapp-chat'].on_page_load = function(wrapper) {
    const page = frappe.ui.make_app_page({
        parent: wrapper,
        title: 'WhatsApp Chat',
        single_column: true
    });

    new WhatsAppChat(page);
};

class WhatsAppChat {
    constructor(page) {
        this.page = page;
        this.current_phone = null;
        this.conversations = [];
        this.messages = [];
        this.refresh_interval = null;
        this.last_message_count = 0;
        this.is_user_scrolled_up = false;
        this.search_timeout = null;
        
        this.setup_page();
        this.load_conversations();
        this.setup_realtime();
        this.setup_periodic_refresh();
        this.setup_scroll_detection();
    }
    
    setup_scroll_detection() {
        // This is now handled in setup_listeners
        // Kept for backwards compatibility but not needed
    }
    
    setup_periodic_refresh() {
        // Refresh conversations every 30 seconds silently
        this.refresh_interval = setInterval(() => {
            this.load_conversations(true);
            
            // If viewing a conversation, refresh messages too
            if (this.current_phone) {
                this.load_messages(this.current_phone, true);
            }
        }, 30000); // 30 seconds
        
        // Clear interval when page is unloaded
        $(window).on('beforeunload', () => {
            if (this.refresh_interval) {
                clearInterval(this.refresh_interval);
            }
        });
    }

    setup_page() {
        // Load HTML template
        $(this.page.body).html(frappe.render_template('whatsapp_chat'));
        
        // Setup event listeners
        this.setup_listeners();
        
        // Setup lightbox close
        this.setup_lightbox();
        
        // Request notification permission
        this.request_notification_permission();
    }
    
    setup_lightbox() {
        $('#lightbox-close, #image-lightbox').on('click', function(e) {
            if (e.target.id === 'lightbox-close' || e.target.id === 'image-lightbox') {
                $('#image-lightbox').fadeOut(200);
            }
        });
        
        // Prevent closing when clicking on image
        $('#lightbox-image').on('click', function(e) {
            e.stopPropagation();
        });
        
        // Close on ESC key
        $(document).on('keydown', function(e) {
            if (e.key === 'Escape') {
                $('#image-lightbox').fadeOut(200);
            }
        });
    }
    
    request_notification_permission() {
        if ('Notification' in window && Notification.permission === 'default') {
            Notification.requestPermission().then(permission => {
                if (permission === 'granted') {
                    console.log('Notification permission granted');
                }
            });
        }
    }

    setup_listeners() {
        const self = this;
        
        // Search functionality with debouncing
        $('#chat-search').on('input', function() {
            const query = $(this).val().toLowerCase();
            
            // Clear previous timeout
            if (self.search_timeout) {
                clearTimeout(self.search_timeout);
            }
            
            // Debounce search by 300ms
            self.search_timeout = setTimeout(() => {
                self.filter_conversations(query);
            }, 300);
            
            // Show/hide clear button immediately
            if (query) {
                $('#search-clear').show();
            } else {
                $('#search-clear').hide();
                // Clear search immediately when empty
                clearTimeout(self.search_timeout);
                self.filter_conversations('');
            }
        });
        
        // Clear search button
        $('#search-clear').on('click', function() {
            $('#chat-search').val('');
            $('#search-clear').hide();
            self.filter_conversations('');
            $('#chat-search').focus();
        });
        
        // Focus search on keyboard shortcut (Ctrl/Cmd + K)
        $(document).on('keydown', function(e) {
            if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
                e.preventDefault();
                $('#chat-search').focus();
            }
        });
        
        // Send message on Enter
        $('#message-input').on('keypress', function(e) {
            if (e.which === 13 && !e.shiftKey) {
                e.preventDefault();
                self.send_message();
            }
        });
        
        // Send button click
        $('#send-btn').on('click', () => this.send_message());
        
        // Attach button click
        $('#attach-btn').on('click', () => {
            $('#media-upload').click();
        });
        
        // Media file selected
        $('#media-upload').on('change', function(e) {
            const file = e.target.files[0];
            if (file) {
                self.handle_media_upload(file);
            }
            // Reset input
            $(this).val('');
        });
        
        // Scroll to bottom button
        $('#scroll-to-bottom-btn').on('click', () => {
            this.is_user_scrolled_up = false;
            this.scroll_to_bottom(true);
            $('#scroll-to-bottom-btn').fadeOut(200);
        });
        
        // Monitor scroll position
        $(document).on('scroll', '#chat-messages', function() {
            const container = this;
            const scrollTop = container.scrollTop;
            const scrollHeight = container.scrollHeight;
            const clientHeight = container.clientHeight;
            const scrolledToBottom = scrollHeight - scrollTop - clientHeight < 50;
            
            self.is_user_scrolled_up = !scrolledToBottom;
            
            // Show/hide scroll to bottom button
            if (self.is_user_scrolled_up && scrollHeight > clientHeight + 100) {
                $('#scroll-to-bottom-btn').fadeIn(200);
            } else {
                $('#scroll-to-bottom-btn').fadeOut(200);
            }
        });
    }

    async load_conversations(silent = false) {
        try {
            const response = await frappe.call({
                method: 'frappe_pywce.frappe_pywce.page.whatsapp_chat.whatsapp_chat.get_conversations',
                freeze: !silent,
                freeze_message: silent ? '' : 'Loading conversations...'
            });
            
            this.conversations = response.message || [];
            this.render_conversations();
        } catch (error) {
            if (!silent) {
                frappe.msgprint({
                    title: 'Error',
                    message: 'Failed to load conversations',
                    indicator: 'red'
                });
            }
        }
    }

    render_conversations() {
        const container = $('#conversations-list');
        container.empty();
        
        if (this.conversations.length === 0) {
            container.html('<div style="padding: 20px; text-align: center; color: #667781;">No conversations yet</div>');
            return;
        }
        
        this.conversations.forEach(conv => {
            const initials = this.get_initials(conv.contact_name || conv.phone_number);
            const time = this.format_time(conv.last_message_time);
            const unread = conv.unread_count > 0 ? 
                `<span class="unread-badge">${conv.unread_count}</span>` : '';
            
            // Check if this is currently active conversation
            const isActive = this.current_phone === conv.phone_number ? 'active' : '';
            
            const html = `
                <div class="conversation-item ${isActive}" data-phone="${conv.phone_number}">
                    <div class="conversation-avatar">${initials}</div>
                    <div class="conversation-content">
                        <div class="conversation-header">
                            <span class="conversation-name">${conv.contact_name || conv.phone_number}</span>
                            <span class="conversation-time">${time}</span>
                        </div>
                        <div class="conversation-preview">
                            <span class="conversation-last-message">${this.truncate(conv.last_message || '', 40)}</span>
                            ${unread}
                        </div>
                    </div>
                </div>
            `;
            
            const $item = $(html);
            $item.on('click', () => this.open_conversation(conv.phone_number));
            container.append($item);
        });
    }

    async open_conversation(phone_number) {
        this.current_phone = phone_number;
        this.is_user_scrolled_up = false; // Reset scroll state for new conversation
        
        // Update UI
        $('.conversation-item').removeClass('active');
        $(`.conversation-item[data-phone="${phone_number}"]`).addClass('active');
        
        $('#chat-empty').hide();
        $('#chat-window').show();
        
        // Update header
        const conv = this.conversations.find(c => c.phone_number === phone_number);
        $('#contact-name').text(conv?.contact_name || phone_number);
        $('#contact-number').text(phone_number);
        
        // Load messages
        await this.load_messages(phone_number);
    }

    async load_messages(phone_number, silent = false) {
        try {
            const response = await frappe.call({
                method: 'frappe_pywce.frappe_pywce.page.whatsapp_chat.whatsapp_chat.get_messages',
                args: { phone_number },
                freeze: !silent
            });
            
            const old_count = this.messages.length;
            this.messages = response.message || [];
            const new_count = this.messages.length;
            
            this.render_messages();
            
            // Decide whether to scroll based on context
            if (!silent) {
                // Initial load or user action - always scroll to bottom
                this.scroll_to_bottom(true);
            } else {
                // Silent update - only scroll if new messages arrived and user is at bottom
                if (new_count > old_count && !this.is_user_scrolled_up) {
                    this.scroll_to_bottom(true);
                }
                // If user has scrolled up, don't auto-scroll (let them read old messages)
            }
        } catch (error) {
            if (!silent) {
                frappe.msgprint({
                    title: 'Error',
                    message: 'Failed to load messages',
                    indicator: 'red'
                });
            }
        }
    }

    render_messages() {
        const container = $('#chat-messages');
        container.empty();
        
        this.messages.forEach(msg => {
            const direction = msg.direction.toLowerCase();
            const time = this.format_message_time(msg.timestamp);
            
            // Status indicator for outgoing messages
            let statusIcon = '';
            let bubbleClass = '';
            
            if (direction === 'outgoing') {
                if (msg.status === 'sending') {
                    statusIcon = ' 🕐';
                    bubbleClass = 'sending';
                } else if (msg.status === 'sent') {
                    statusIcon = ' ✓';
                } else if (msg.status === 'delivered') {
                    statusIcon = ' ✓✓';
                } else if (msg.status === 'read') {
                    statusIcon = ' <span style="color: #53bdeb;">✓✓</span>';
                } else if (msg.status === 'failed') {
                    statusIcon = ' ⚠️';
                }
            }
            
            // Render different message types
            let messageContent = '';
            
            switch(msg.message_type) {
                case 'text':
                    messageContent = this.render_text_message(msg);
                    break;
                case 'image':
                    messageContent = this.render_image_message(msg);
                    break;
                case 'video':
                    messageContent = this.render_video_message(msg);
                    break;
                case 'audio':
                case 'voice':
                    messageContent = this.render_audio_message(msg);
                    break;
                case 'document':
                    messageContent = this.render_document_message(msg);
                    break;
                case 'location':
                    messageContent = this.render_location_message(msg);
                    break;
                case 'contacts':
                    messageContent = this.render_contact_message(msg);
                    break;
                case 'sticker':
                    messageContent = this.render_sticker_message(msg);
                    break;
                case 'button':
                case 'interactive':
                    messageContent = this.render_interactive_message(msg);
                    break;
                default:
                    messageContent = this.render_text_message(msg);
            }
            
            const html = `
                <div class="message ${direction}">
                    <div class="message-bubble ${bubbleClass}">
                        ${messageContent}
                        <div class="message-time">${time}${statusIcon}</div>
                    </div>
                </div>
            `;
            
            container.append(html);
        });
        
        // Load media for messages with media_url
        this.load_media_urls();
    }
    
    render_text_message(msg) {
        return `<div class="message-text">${this.escape_html(msg.message_text || '')}</div>`;
    }
    
    render_image_message(msg) {
        return `
            <div class="media-message image-message">
                <img class="media-image" data-media-id="${msg.media_url}" src="/assets/frappe/images/ui/image-placeholder.png" alt="Image" />
                ${msg.message_text ? `<div class="media-caption">${this.escape_html(msg.message_text)}</div>` : ''}
            </div>
        `;
    }
    
    render_video_message(msg) {
        return `
            <div class="media-message video-message">
                <video class="media-video" data-media-id="${msg.media_url}" controls>
                    <source src="/assets/frappe/images/ui/video-placeholder.png" type="video/mp4">
                    Your browser does not support video.
                </video>
                ${msg.message_text ? `<div class="media-caption">${this.escape_html(msg.message_text)}</div>` : ''}
            </div>
        `;
    }
    
    render_audio_message(msg) {
        const isVoice = msg.message_type === 'voice';
        return `
            <div class="media-message audio-message">
                <div class="audio-icon">${isVoice ? '🎤' : '🎵'}</div>
                <audio class="media-audio" data-media-id="${msg.media_url}" controls>
                    Your browser does not support audio.
                </audio>
                ${!isVoice && msg.message_text ? `<div class="message-text">${this.escape_html(msg.message_text)}</div>` : ''}
            </div>
        `;
    }
    
    render_document_message(msg) {
        return `
            <div class="media-message document-message">
                <div class="document-icon">📄</div>
                <div class="document-info">
                    <div class="document-name">${this.escape_html(msg.message_text || 'Document')}</div>
                    <a href="#" class="document-download" data-media-id="${msg.media_url}">Download</a>
                </div>
            </div>
        `;
    }
    
    render_location_message(msg) {
        const metadata = msg.metadata || {};
        const location = metadata.location || {};
        const lat = location.latitude;
        const lng = location.longitude;
        const name = location.name || 'Location';
        const address = location.address || '';
        
        return `
            <div class="media-message location-message">
                <div class="location-icon">📍</div>
                <div class="location-info">
                    <div class="location-name">${this.escape_html(name)}</div>
                    ${address ? `<div class="location-address">${this.escape_html(address)}</div>` : ''}
                    ${lat && lng ? `<a href="https://www.google.com/maps?q=${lat},${lng}" target="_blank" class="location-link">View on Map</a>` : ''}
                </div>
            </div>
        `;
    }
    
    render_contact_message(msg) {
        const metadata = msg.metadata || {};
        const contacts = metadata.contacts || [];
        const contact = contacts[0] || {};
        const name = contact.name?.formatted_name || 'Contact';
        const phones = contact.phones || [];
        
        return `
            <div class="media-message contact-message">
                <div class="contact-icon">👤</div>
                <div class="contact-info">
                    <div class="contact-name">${this.escape_html(name)}</div>
                    ${phones.length > 0 ? `<div class="contact-phone">${this.escape_html(phones[0].phone || '')}</div>` : ''}
                </div>
            </div>
        `;
    }
    
    render_sticker_message(msg) {
        return `
            <div class="media-message sticker-message">
                <img class="media-sticker" data-media-id="${msg.media_url}" src="/assets/frappe/images/ui/image-placeholder.png" alt="Sticker" />
            </div>
        `;
    }
    
    render_interactive_message(msg) {
        return `
            <div class="interactive-message">
                <div class="interactive-icon">🔘</div>
                <div class="message-text">${this.escape_html(msg.message_text || 'Interactive message')}</div>
            </div>
        `;
    }
    
    async load_media_urls() {
        // Find all media elements that need URLs
        const mediaElements = $('.media-image[data-media-id], .media-video[data-media-id], .media-audio[data-media-id], .media-sticker[data-media-id], .document-download[data-media-id]');
        
        mediaElements.each(async (index, element) => {
            const $el = $(element);
            const mediaId = $el.data('media-id');
            
            if (!mediaId || mediaId === 'null') return;
            
            try {
                const response = await frappe.call({
                    method: 'frappe_pywce.frappe_pywce.page.whatsapp_chat.whatsapp_chat.get_media_url',
                    args: { media_id: mediaId }
                });
                
                if (response.message.success) {
                    const url = response.message.url;
                    
                    if ($el.hasClass('media-image') || $el.hasClass('media-sticker')) {
                        $el.attr('src', url);
                        // Add click handler for lightbox
                        if ($el.hasClass('media-image')) {
                            $el.on('click', () => this.show_image_lightbox(url));
                        }
                    } else if ($el.hasClass('media-video')) {
                        $el.find('source').attr('src', url);
                        $el[0].load();
                    } else if ($el.hasClass('media-audio')) {
                        $el.attr('src', url);
                    } else if ($el.hasClass('document-download')) {
                        $el.attr('href', url);
                    }
                }
            } catch (error) {
                console.error('Failed to load media:', error);
            }
        });
    }
    
    show_image_lightbox(imageUrl) {
        $('#lightbox-image').attr('src', imageUrl);
        $('#image-lightbox').fadeIn(200);
    }

    async send_message() {
        const input = $('#message-input');
        const text = input.val().trim();
        
        if (!text || !this.current_phone) return;
        
        // Clear input immediately
        input.val('');
        
        // Disable send button temporarily
        const sendBtn = $('#send-btn');
        sendBtn.prop('disabled', true);
        
        // Mark that user is sending (they want to see the message)
        this.is_user_scrolled_up = false;
        
        try {
            const response = await frappe.call({
                method: 'frappe_pywce.frappe_pywce.page.whatsapp_chat.whatsapp_chat.send_message',
                args: {
                    phone_number: this.current_phone,
                    message_text: text
                }
            });
            
            if (response.message.success) {
                // Add message to UI immediately with "sending" status
                this.messages.push(response.message.message);
                this.render_messages();
                this.scroll_to_bottom(true); // Force scroll to see sent message
                
                // Update conversation list silently in background
                this.load_conversations(true);
            } else {
                frappe.msgprint({
                    title: 'Error',
                    message: response.message.error || 'Failed to send message',
                    indicator: 'red'
                });
                // Restore the text if send failed
                input.val(text);
            }
        } catch (error) {
            frappe.msgprint({
                title: 'Error',
                message: 'Failed to send message',
                indicator: 'red'
            });
            // Restore the text if send failed
            input.val(text);
        } finally {
            // Re-enable send button
            sendBtn.prop('disabled', false);
            input.focus();
        }
    }

    filter_conversations(query) {
        if (!query) {
            // Show all conversations if search is empty
            $('.conversation-item').show();
            $('.conversation-name, .conversation-last-message').each(function() {
                $(this).html($(this).text());
            });
            $('#no-search-results').remove();
            return;
        }
        
        let visibleCount = 0;
        
        $('.conversation-item').each(function() {
            const $item = $(this);
            const $name = $item.find('.conversation-name');
            const $message = $item.find('.conversation-last-message');
            const phone = $item.data('phone').toString().toLowerCase();
            
            const name = $name.text().toLowerCase();
            const message = $message.text().toLowerCase();
            
            // Search in name, phone number, or last message
            const nameMatch = name.includes(query);
            const phoneMatch = phone.includes(query);
            const messageMatch = message.includes(query);
            
            if (nameMatch || phoneMatch || messageMatch) {
                $item.show();
                visibleCount++;
                
                // Highlight matching text
                if (nameMatch) {
                    $name.html(highlightText($name.text(), query));
                } else {
                    $name.html($name.text());
                }
                
                if (messageMatch) {
                    $message.html(highlightText($message.text(), query));
                } else {
                    $message.html($message.text());
                }
            } else {
                $item.hide();
            }
        });
        
        // Show "no results" message if nothing matches
        if (visibleCount === 0) {
            if ($('#no-search-results').length === 0) {
                $('#conversations-list').append(`
                    <div id="no-search-results" style="padding: 20px; text-align: center; color: #667781;">
                        <div style="font-size: 48px; margin-bottom: 10px;">🔍</div>
                        <div style="font-weight: 500; margin-bottom: 5px;">No results found</div>
                        <div style="font-size: 13px;">Try searching with a different term</div>
                    </div>
                `);
            }
        } else {
            $('#no-search-results').remove();
        }
        
        // Helper function to highlight text
        function highlightText(text, query) {
            if (!query) return text;
            const regex = new RegExp(`(${escapeRegExp(query)})`, 'gi');
            return text.replace(regex, '<mark style="background: #ffeb3b; color: #000; padding: 2px 0; border-radius: 2px;">$1</mark>');
        }
        
        // Helper function to escape regex special characters
        function escapeRegExp(string) {
            return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        }
    }

    setup_realtime() {
        const self = this;
        
        // Listen for new incoming messages
        frappe.realtime.on('whatsapp_message_received', (data) => {
            console.log('New message received:', data);
            
            // Update conversation list silently
            self.load_conversations(true);
            
            // If viewing this conversation, add message
            if (self.current_phone === data.phone_number) {
                // Check if user is at bottom before loading
                const wasAtBottom = !self.is_user_scrolled_up;
                
                // Reload messages silently to get the new message
                self.load_messages(data.phone_number, true).then(() => {
                    // Only scroll if user was at bottom
                    if (wasAtBottom) {
                        self.scroll_to_bottom(true);
                    }
                });
                
                // Show notification sound or visual indicator (optional)
                self.play_notification_sound();
            } else {
                // Show desktop notification for other conversations
                self.show_notification(data);
            }
        });
        
        // Listen for message status updates (sent, delivered, read)
        frappe.realtime.on('whatsapp_message_status_updated', (data) => {
            console.log('Message status updated:', data);
            
            // Update message status in current view without reload
            if (self.current_phone === data.phone_number) {
                const message = self.messages.find(m => m.name === data.message_name);
                if (message) {
                    message.status = data.status;
                    if (data.error) {
                        message.error_message = data.error;
                    }
                    // Re-render only the messages, not the whole list
                    self.render_messages();
                }
            }
            
            // Update conversation list silently to show updated preview
            self.load_conversations(true);
        });
    }
    
    play_notification_sound() {
        // Optional: Play a subtle notification sound
        // You can add an audio element or use Web Audio API
        try {
            // Uncomment if you want sound notifications
            // const audio = new Audio('/assets/frappe/sounds/notification.mp3');
            // audio.volume = 0.3;
            // audio.play().catch(e => console.log('Sound play failed:', e));
        } catch (e) {
            console.log('Notification sound error:', e);
        }
    }
    
    show_notification(data) {
        // Show browser notification for messages in other conversations
        if ('Notification' in window && Notification.permission === 'granted') {
            const conv = this.conversations.find(c => c.phone_number === data.phone_number);
            const title = conv?.contact_name || data.phone_number;
            
            new Notification(title, {
                body: data.message_text || 'New message',
                icon: '/assets/frappe/images/frappe-favicon.svg',
                tag: data.phone_number
            });
        }
    }

    scroll_to_bottom(force = false) {
        const container = document.getElementById('chat-messages');
        if (!container) return;
        
        // If force is true, scroll immediately
        // Otherwise, check if user is scrolled up
        if (force || !this.is_user_scrolled_up) {
            requestAnimationFrame(() => {
                container.scrollTop = container.scrollHeight;
            });
        }
    }
    
    scroll_to_bottom_if_near() {
        // Only auto-scroll if user is near the bottom (within 100px)
        const container = document.getElementById('chat-messages');
        if (container) {
            const isNearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 100;
            if (isNearBottom) {
                this.is_user_scrolled_up = false;
                requestAnimationFrame(() => {
                    container.scrollTop = container.scrollHeight;
                });
            }
        }
    }

    get_initials(name) {
        if (!name) return '?';
        const parts = name.split(' ');
        if (parts.length >= 2) {
            return (parts[0][0] + parts[1][0]).toUpperCase();
        }
        return name.substring(0, 2).toUpperCase();
    }

    format_time(timestamp) {
        if (!timestamp) return '';
        const date = new Date(timestamp);
        const now = new Date();
        const diff = now - date;
        
        // Less than 24 hours - show time
        if (diff < 86400000) {
            return date.toLocaleTimeString('en-US', { 
                hour: '2-digit', 
                minute: '2-digit',
                hour12: false 
            });
        }
        
        // Less than 7 days - show day
        if (diff < 604800000) {
            return date.toLocaleDateString('en-US', { weekday: 'short' });
        }
        
        // Older - show date
        return date.toLocaleDateString('en-US', { 
            month: 'short', 
            day: 'numeric' 
        });
    }

    format_message_time(timestamp) {
        if (!timestamp) return '';
        const date = new Date(timestamp);
        return date.toLocaleTimeString('en-US', { 
            hour: '2-digit', 
            minute: '2-digit',
            hour12: false 
        });
    }

    truncate(text, length) {
        if (!text) return '';
        return text.length > length ? text.substring(0, length) + '...' : text;
    }

    escape_html(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
}