/**
 * SendGrid Email Template Integration
 * Connects The Ultimate Journey platform with SendGrid dynamic templates
 * 
 * Templates:
 * - sponsored_denied_v1
 * - sponsored_approved_v1
 * - birthday_send_v1
 * - internal_signup_notification_v1
 * - boarding_pass_paid_v1
 * - boarding_pass_free_v1
 */

// Configuration - template IDs from SendGrid Dynamic Templates
// API key and platform URL are injected at runtime via Netlify env vars
const SENDGRID_CONFIG = {
    apiKey: typeof process !== 'undefined' ? process.env.SENDGRID_API_KEY : 'YOUR_SENDGRID_API_KEY',
    templates: {
        sponsoredDenied: 'd-TEMPLATE_ID_1',
        sponsoredApproved: 'd-TEMPLATE_ID_2',
        birthdaySend: 'd-TEMPLATE_ID_3',
        internalSignup: 'd-TEMPLATE_ID_4',
        boardingPassPaid: 'd-TEMPLATE_ID_5',
        boardingPassFree: 'd-TEMPLATE_ID_6',
        // #116 — Seat confirmation / onboarding (welcome_onboarding_v1)
        onboardingConfirm: 'd-9e8a25a22d1b438c84b8f5b7bb25c46c',
        // #118 — Seat request acknowledgement (seat_request_acknowledgement_v1)
        seatRequest: 'd-740595dc07be40129569bc731f1bc454'
    },
    fromEmail: 'noreply@thispagedoesnotexist12345.com',
    adminEmail: 'YOUR_ADMIN_EMAIL', // For internal notifications
    platformUrl: typeof process !== 'undefined' ? process.env.PLATFORM_URL : 'https://app.base44.com/apps/697140e628131a06045ebd18/editor/preview'
};

/**
 * Send email via SendGrid API
 */
async function sendEmail(templateId, toEmail, dynamicData, fromEmail = SENDGRID_CONFIG.fromEmail) {
    try {
        const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${SENDGRID_CONFIG.apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                from: { email: fromEmail },
                personalizations: [{
                    to: [{ email: toEmail }],
                    dynamic_template_data: dynamicData
                }],
                template_id: templateId
            })
        });

        if (response.ok) {
            console.log(`[SendGrid] Email sent successfully to ${toEmail}`);
            return { success: true };
        } else {
            const error = await response.text();
            console.error(`[SendGrid] Failed to send email:`, error);
            return { success: false, error };
        }
    } catch (error) {
        console.error(`[SendGrid] Error sending email:`, error);
        return { success: false, error: error.message };
    }
}

/**
 * 1. INTERNAL SIGNUP NOTIFICATION
 * Triggered when new user signs up
 */
function sendSignupNotification(userData) {
    const dynamicData = {
        user_name: userData.name || 'New User',
        user_email: userData.email,
        signup_date: new Date().toISOString(),
        signup_source: userData.source || 'Direct',
        user_ip: userData.ip || 'Unknown',
        first_path_chosen: userData.firstPath || 'None yet'
    };

    return sendEmail(
        SENDGRID_CONFIG.templates.internalSignup,
        SENDGRID_CONFIG.adminEmail,
        dynamicData
    );
}

/**
 * 2. BOARDING PASS - FREE TIER
 * Sent when user completes signup without payment
 */
function sendFreePass(userEmail, userData) {
    const dynamicData = {
        user_name: userData.name || 'Traveler',
        access_level: 'Free Tier',
        features: [
            'Access to Signal Newsletter',
            'Basic Systems Tools',
            'Community Access'
        ],
        activation_date: new Date().toISOString(),
        next_flight_date: '2026-03-21',
        puzzle_hint: 'Explore all three paths to unlock the next stage',
        newsletter_url: 'https://newsletter.thispagedoesnotexist12345.us/',
        dashboard_url: 'https://www.thispagedoesnotexist12345.com/'
    };

    return sendEmail(
        SENDGRID_CONFIG.templates.boardingPassFree,
        userEmail,
        dynamicData
    );
}

/**
 * 3. BOARDING PASS - PAID TIER
 * Sent when user makes payment/supports the platform
 */
function sendPaidPass(userEmail, userData) {
    const dynamicData = {
        user_name: userData.name || 'Premium Traveler',
        access_level: 'Premium Tier',
        payment_amount: userData.amount || '0',
        transaction_id: userData.transactionId || 'N/A',
        features: [
            'Premium Signal Newsletter',
            'Advanced Systems Access',
            'Priority Support',
            'Early Access to New Features',
            'Exclusive Career Resources'
        ],
        activation_date: new Date().toISOString(),
        next_flight_date: '2026-03-21',
        premium_dashboard_url: 'https://www.thispagedoesnotexist12345.com/premium',
        special_unlock: 'Premium members get exclusive March 21st insights'
    };

    return sendEmail(
        SENDGRID_CONFIG.templates.boardingPassPaid,
        userEmail,
        dynamicData
    );
}

/**
 * 4. BIRTHDAY EMAIL
 * Scheduled send for user birthdays
 */
function sendBirthdayEmail(userEmail, userData) {
    const dynamicData = {
        user_name: userData.name,
        birthday_year: new Date().getFullYear(),
        special_offer: 'Unlock premium access with birthday discount',
        gift_message: 'Your journey continues to evolve',
        cta_url: 'https://buymeacoffee.com/theultimatejourney'
    };

    return sendEmail(
        SENDGRID_CONFIG.templates.birthdaySend,
        userEmail,
        dynamicData
    );
}

/**
 * 5. SPONSORSHIP APPROVED
 * Sent when sponsorship request is approved
 */
function sendSponsorshipApproved(sponsorEmail, sponsorData) {
    const dynamicData = {
        sponsor_name: sponsorData.name,
        sponsor_company: sponsorData.company || 'N/A',
        approval_date: new Date().toISOString(),
        sponsorship_tier: sponsorData.tier || 'Standard',
        next_steps: [
            'Review brand guidelines',
            'Submit creative assets',
            'Schedule kickoff call'
        ],
        contact_email: SENDGRID_CONFIG.adminEmail,
        portal_url: 'https://www.thispagedoesnotexist12345.com/sponsors'
    };

    return sendEmail(
        SENDGRID_CONFIG.templates.sponsoredApproved,
        sponsorEmail,
        dynamicData
    );
}

/**
 * 6. SPONSORSHIP DENIED
 * Sent when sponsorship request is declined
 */
function sendSponsorshipDenied(sponsorEmail, sponsorData) {
    const dynamicData = {
        sponsor_name: sponsorData.name,
        denial_reason: sponsorData.reason || 'Not aligned with current platform goals',
        denial_date: new Date().toISOString(),
        alternative_options: [
            'Consider supporting via Buy Me a Coffee',
            'Reapply in 6 months',
            'Explore community partnership opportunities'
        ],
        feedback_message: 'We appreciate your interest in The Ultimate Journey'
    };

    return sendEmail(
        SENDGRID_CONFIG.templates.sponsoredDenied,
        sponsorEmail,
        dynamicData
    );
}

/**
 * 7. SEAT CONFIRMATION (onboarding)
 * #116 — Triggered by handleSeatOpened (Base44 function) when a seat is opened/confirmed.
 * Sends welcome_onboarding_v1 with seat context.
 * Dynamic fields: first_name, last_name, seat_id, platform_url, unsubscribe_url
 */
function sendSeatConfirmation(passengerEmail, passengerData) {
    const dynamicData = {
        first_name: passengerData.first_name || passengerData.name || 'Passenger',
        last_name: passengerData.last_name || '',
        seat_id: passengerData.seat_id || '',
        platform_url: passengerData.platform_url || SENDGRID_CONFIG.platformUrl,
        unsubscribe_url: passengerData.unsubscribe_url || ''
    };
    return sendEmail(
        SENDGRID_CONFIG.templates.onboardingConfirm,
        passengerEmail,
        dynamicData
    );
}

/**
 * EVENT LISTENERS - Connect to existing platform actions
 */
function initializeSendGridIntegration() {
    console.log('[SendGrid] Integration initialized');

    // Listen for new user signups
    window.addEventListener('user-signup', async (event) => {
        const userData = event.detail;
        console.log('[SendGrid] New signup detected:', userData.email);
        
        // Send internal notification
        await sendSignupNotification(userData);
        
        // Send appropriate boarding pass
        if (userData.isPaid) {
            await sendPaidPass(userData.email, userData);
        } else {
            await sendFreePass(userData.email, userData);
        }
    });

    // Listen for puzzle completion (all 3 paths chosen)
    window.addEventListener('puzzle-unlocked', async (event) => {
        const userData = event.detail;
        console.log('[SendGrid] Puzzle unlocked for:', userData.email);
        // Could trigger special email here
    });

    // Listen for sponsorship decisions
    window.addEventListener('sponsorship-decision', async (event) => {
        const { approved, sponsorData } = event.detail;
        if (approved) {
            await sendSponsorshipApproved(sponsorData.email, sponsorData);
        } else {
            await sendSponsorshipDenied(sponsorData.email, sponsorData);
        }
    });

    // #116 — Listen for seat-opened events from Base44 handleSeatOpened
    // Payload: { email, first_name, last_name, seat_id, platform_url, unsubscribe_url }
    window.addEventListener('seat-opened', async (event) => {
        const passengerData = event.detail;
        console.log('[SendGrid] Seat opened for:', passengerData.email);
        await sendSeatConfirmation(passengerData.email, passengerData);
    });

    // Birthday check (run daily)
    checkBirthdays();
}

/**
 * Check for user birthdays and send emails
 */
async function checkBirthdays() {
    // This would connect to your user database
    // For now, it's a placeholder
    console.log('[SendGrid] Birthday check running');
    
    // Example: Get users from your database/Notion
    // const usersWithBirthdays = await fetchBirthdayUsers();
    // for (const user of usersWithBirthdays) {
    //     await sendBirthdayEmail(user.email, user);
    // }
}

/**
 * HELPER: Trigger signup from form submission
 * #118 — POSTs to /api/seat-request server-side (SendGrid call moved off client).
 * The user-signup event still fires with skipSeatRequest: true so analytics
 * listeners remain undisturbed.
 */
async function handleFormSubmit(formData) {
    const name = formData.get('name');
    const email = formData.get('email');
    const source = formData.get('source') || 'Website';

    // --- Server-side seat request acknowledgement (#118) ---
    try {
        const response = await fetch('/api/seat-request', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, email, source })
        });
        const result = await response.json();
        if (result.ok) {
            console.log('[SendGrid] Seat request acknowledgement sent via server-side handler');
        } else {
            console.error('[SendGrid] Seat request handler error:', result.error);
        }
    } catch (err) {
        console.error('[SendGrid] Failed to reach /api/seat-request:', err);
    }

    // --- Analytics event (skipSeatRequest: true keeps listeners undisturbed) ---
    const userData = {
        name,
        email,
        source,
        isPaid: false,
        firstPath: localStorage.getItem('last-path') || 'None',
        skipSeatRequest: true
    };
    window.dispatchEvent(new CustomEvent('user-signup', { detail: userData }));
}

/**
 * HELPER: Track path choices and unlock logic
 */
function enhancePathTracking() {
    const pathButtons = document.querySelectorAll('.btn-row .btn');
    
    pathButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            const path = btn.dataset.path;
            const chosen = JSON.parse(localStorage.getItem('paths-chosen') || '[]');
            
            if (!chosen.includes(path)) {
                chosen.push(path);
                localStorage.setItem('paths-chosen', JSON.stringify(chosen));
            }
            
            // Check if all 3 paths unlocked
            if (chosen.length === 3) {
                const userEmail = localStorage.getItem('user-email');
                if (userEmail) {
                    window.dispatchEvent(new CustomEvent('puzzle-unlocked', {
                        detail: { email: userEmail }
                    }));
                }
            }
        });
    });
}

// Initialize when DOM is ready
if (typeof window !== 'undefined') {
    document.addEventListener('DOMContentLoaded', () => {
        initializeSendGridIntegration();
        enhancePathTracking();
    });
}

// Export functions for external use
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        sendSignupNotification,
        sendFreePass,
        sendPaidPass,
        sendBirthdayEmail,
        sendSponsorshipApproved,
        sendSponsorshipDenied,
        sendSeatConfirmation, // #116
        initializeSendGridIntegration
    };
}
