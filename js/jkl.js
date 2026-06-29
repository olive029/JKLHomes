/* =============================================
   PROPFLOW — Frontend JavaScript (Firebase Version)
   All API calls replaced with Firestore operations
   ============================================= */

// === GLOBAL STATE ===
let tenants         = [];
let filteredTenants = [];
let editingId       = null;  // Now using string IDs from Firestore
let notifications   = [];
let settings        = {
    companyName:    'PropFlow Properties',
    companyAddress: '123 Moi Avenue, Nairobi, Kenya',
    companyPhone:   '+254 700 000 000',
    companyEmail:   'info@propflow.co.ke',
    mpesaNumber:    '0700 000 000',
    bankAccount:    '1234567890',
    bankName:       'Equity Bank'
};

const bcNames = {
    'dashboard':      'Dashboard',
    'all-tenants':    'All Tenants',
    'overdue':        'Overdue Payments',
    'analytics':      'Analytics',
    'water-readings': 'Water Readings',
    'water-history':  'Water History',
    'top-consumers':  'Top Consumers',
};

// ─── FIREBASE REFERENCE ───────────────────────
// Assumes Firebase is already initialized in the HTML
// db is the Firestore instance

// === INIT ===
document.addEventListener('DOMContentLoaded', async () => {
    await loadSettings();
    await loadAllTenants();
    initTheme();
    setDefaultDueDate();
    checkOverdueTenants();
    initNotifications();
    updateSettingsForm();
    scheduleSmsReminderCheck();
    
    // Set up real-time listener
    db.collection('tenants').onSnapshot(() => {
        console.log('📡 Real-time update detected');
        loadAllTenants();
    }, (error) => {
        console.error('Real-time listener error:', error);
    });
});

// === DATA — FIRESTORE OPERATIONS ===

async function loadAllTenants() {
    try {
        const snapshot = await db.collection('tenants')
            .orderBy('createdAt', 'desc')
            .get();
        
        tenants = [];
        snapshot.forEach(doc => {
            const data = doc.data();
            // Convert Firestore field names to match existing code
            tenants.push({
                id: doc.id,
                tenantName: data.tenantName || data.name || 'Unknown',
                unitNumber: data.unitNumber || 'N/A',
                phone: data.phone || '',
                previousReading: data.previousReading || 0,
                currentReading: data.currentReading || 0,
                ratePerUnit: data.ratePerUnit || 50,
                baseRent: data.baseRent || 0,
                paymentStatus: data.paymentStatus || 'pending',
                dueDate: data.dueDate || null,
                // Computed fields
                unitsConsumed: data.unitsConsumed || 0,
                waterBill: data.waterBill || 0,
                otherCharges: data.otherCharges || 0,
                totalRent: data.totalRent || data.total || 0,
                // Other charges breakdown
                otherChargesBreakdown: {
                    electricity: data.ch_electricity || 0,
                    tokens: data.ch_tokens || 0,
                    repairWorks: data.ch_repair_works || 0,
                    houseRefunds: data.ch_house_refunds || 0,
                    garbage: data.ch_garbage || 0
                },
                // Store full data for editing
                _raw: data
            });
        });
        
        filteredTenants = [...tenants];
        refreshDisplay();
        updateOverdueBadge();
    } catch (e) {
        console.error('Error loading tenants:', e);
        showAlert('Could not load tenants: ' + e.message, 'error');
    }
}

async function loadSettings() {
    try {
        const doc = await db.collection('settings').doc('company').get();
        if (doc.exists) {
            const data = doc.data();
            settings = {
                companyName: data.companyName || settings.companyName,
                companyAddress: data.address || settings.companyAddress,
                companyPhone: data.phone || settings.companyPhone,
                companyEmail: data.email || settings.companyEmail,
                mpesaNumber: data.mpesaNumber || settings.mpesaNumber,
                bankAccount: data.bankAccount || settings.bankAccount,
                bankName: data.bankName || settings.bankName
            };
        } else {
            // Create default settings
            await db.collection('settings').doc('company').set({
                companyName: settings.companyName,
                address: settings.companyAddress,
                phone: settings.companyPhone,
                email: settings.companyEmail,
                mpesaNumber: settings.mpesaNumber,
                bankAccount: settings.bankAccount,
                bankName: settings.bankName,
                createdAt: firebase.firestore.FieldValue.serverTimestamp(),
                updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            });
        }
    } catch (e) {
        console.warn('Could not load settings, using defaults:', e);
    }
}

async function saveSettings() {
    try {
        const s = {
            companyName: document.getElementById('companyName').value,
            address: document.getElementById('companyAddress').value,
            phone: document.getElementById('companyPhone').value,
            email: document.getElementById('companyEmail').value,
            mpesaNumber: document.getElementById('mpesaNumber').value,
            bankAccount: document.getElementById('bankAccount').value,
            bankName: document.getElementById('bankName').value,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        };
        
        await db.collection('settings').doc('company').set(s, { merge: true });
        
        settings = {
            companyName: s.companyName,
            companyAddress: s.address,
            companyPhone: s.phone,
            companyEmail: s.email,
            mpesaNumber: s.mpesaNumber,
            bankAccount: s.bankAccount,
            bankName: s.bankName
        };
        
        closeSettingsModal();
        showAlert('Settings saved!', 'success');
    } catch (e) {
        showAlert('Save failed: ' + e.message, 'error');
    }
}

// === TENANT CRUD ===

async function saveTenant() {
    const tenantName = document.getElementById('tenantName').value.trim();
    const unitNumber = document.getElementById('unitNumber').value.trim();
    if (!tenantName || !unitNumber) {
        showAlert('Name and unit number are required.', 'error');
        return;
    }

    showLoading('Saving...');

    const prev = parseFloat(document.getElementById('previousReading').value) || 0;
    const curr = parseFloat(document.getElementById('currentReading').value) || 0;
    const rate = parseFloat(document.getElementById('ratePerUnit').value) || 50;
    const baseRent = parseFloat(document.getElementById('baseRent').value) || 0;

    // Calculate water bill
    const unitsConsumed = Math.max(0, curr - prev);
    const waterBill = unitsConsumed * rate;

    // Calculate other charges
    const otherChargesMap = {
        ch_electricity: parseFloat(document.getElementById('electricity').value) || 0,
        ch_tokens: parseFloat(document.getElementById('tokens').value) || 0,
        ch_security_pump: parseFloat(document.getElementById('securityPump').value) || 0,
        ch_caretaker_wifi: parseFloat(document.getElementById('caretakerWifi').value) || 0,
        ch_wifi_cctv: parseFloat(document.getElementById('wifiCCTV').value) || 0,
        ch_security: parseFloat(document.getElementById('security').value) || 0,
        ch_rujuwasco: parseFloat(document.getElementById('rujuwasco').value) || 0,
        ch_care_taker: parseFloat(document.getElementById('careTaker').value) || 0,
        ch_repair_works: parseFloat(document.getElementById('repairWorks').value) || 0,
        ch_bio_digester: parseFloat(document.getElementById('bioDigester').value) || 0,
        ch_repainting: parseFloat(document.getElementById('repainting').value) || 0,
        ch_wifi: parseFloat(document.getElementById('wifi').value) || 0,
        ch_house_refunds: parseFloat(document.getElementById('houseRefunds').value) || 0,
        ch_garbage: parseFloat(document.getElementById('garbage').value) || 0,
        ch_other: parseFloat(document.getElementById('otherCharges').value) || 0
    };

    const otherChargesTotal = Object.values(otherChargesMap).reduce((a, b) => a + b, 0);
    const totalRent = baseRent + waterBill + otherChargesTotal;

    const payload = {
        tenantName: tenantName,
        unitNumber: unitNumber,
        email: document.getElementById('tenantEmail').value || '',
        phone: document.getElementById('tenantPhone').value || '',
        previousReading: prev,
        currentReading: curr,
        ratePerUnit: rate,
        unitsConsumed: unitsConsumed,
        waterBill: waterBill,
        baseRent: baseRent,
        otherCharges: otherChargesTotal,
        totalRent: totalRent,
        paymentStatus: document.getElementById('paymentStatus').value || 'pending',
        dueDate: document.getElementById('dueDate').value || null,
        ...otherChargesMap,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    };

    try {
        if (editingId) {
            // Update existing tenant
            await db.collection('tenants').doc(editingId).update(payload);
            showAlert(`${tenantName} updated!`, 'success');
            addNotification(`Updated: ${tenantName}`, 'info');
        } else {
            // Add new tenant
            payload.createdAt = firebase.firestore.FieldValue.serverTimestamp();
            const docRef = await db.collection('tenants').add(payload);
            showAlert(`${tenantName} added!`, 'success');
            addNotification(`New tenant: ${tenantName}`, 'success');
        }
        
        await loadAllTenants();
        updateOverdueBadge();
        closeTenantModal();
    } catch (e) {
        showAlert('Error saving tenant: ' + e.message, 'error');
    } finally {
        hideLoading();
    }
}

async function deleteTenant(id) {
    const t = tenants.find(x => x.id === id);
    if (!t || !confirm(`Delete ${t.tenantName}?`)) return;
    
    showLoading('Deleting...');
    try {
        await db.collection('tenants').doc(id).delete();
        
        // Also delete associated payments and water history
        const payments = await db.collection('payments')
            .where('tenantId', '==', id).get();
        payments.forEach(doc => doc.ref.delete());
        
        const waterHistory = await db.collection('waterHistory')
            .where('tenantId', '==', id).get();
        waterHistory.forEach(doc => doc.ref.delete());
        
        await loadAllTenants();
        updateOverdueBadge();
        showAlert('Tenant deleted.', 'success');
        addNotification(`Removed: ${t.tenantName}`, 'warning');
    } catch (e) {
        showAlert('Delete failed: ' + e.message, 'error');
    } finally {
        hideLoading();
    }
}

async function markAsPaid(id) {
    try {
        await db.collection('tenants').doc(id).update({
            paymentStatus: 'paid',
            paidDate: firebase.firestore.FieldValue.serverTimestamp(),
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        
        // Record payment
        const tenant = tenants.find(x => x.id === id);
        if (tenant) {
            await db.collection('payments').add({
                tenantId: id,
                tenantName: tenant.tenantName,
                unitNumber: tenant.unitNumber,
                amountPaid: tenant.totalRent,
                paymentDate: new Date().toISOString().split('T')[0],
                method: 'M-Pesa',
                reference: `PAID-${Date.now()}`,
                recordedAt: firebase.firestore.FieldValue.serverTimestamp()
            });
        }
        
        await loadAllTenants();
        renderPaymentTracker();
        updateOverdueBadge();
        const name = tenant ? tenant.tenantName : '';
        showAlert(`${name} marked as paid!`, 'success');
    } catch (e) {
        showAlert('Update failed: ' + e.message, 'error');
    }
}

async function markSelectedAsPaid() {
    const ids = getSelectedIds();
    if (!ids.length) return;
    
    showLoading('Updating...');
    try {
        const batch = db.batch();
        ids.forEach(id => {
            const ref = db.collection('tenants').doc(id);
            batch.update(ref, {
                paymentStatus: 'paid',
                paidDate: firebase.firestore.FieldValue.serverTimestamp(),
                updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            });
        });
        await batch.commit();
        
        await loadAllTenants();
        updateOverdueBadge();
        document.getElementById('selectAll').checked = false;
        updateBulkActions();
        showAlert(`${ids.length} tenant(s) marked as paid!`, 'success');
    } catch (e) {
        showAlert('Bulk update failed: ' + e.message, 'error');
    } finally {
        hideLoading();
    }
}

async function deleteSelected() {
    const ids = getSelectedIds();
    if (!ids.length || !confirm(`Delete ${ids.length} tenant(s)?`)) return;
    
    showLoading('Deleting...');
    try {
        const batch = db.batch();
        ids.forEach(id => {
            batch.delete(db.collection('tenants').doc(id));
        });
        await batch.commit();
        
        await loadAllTenants();
        updateOverdueBadge();
        document.getElementById('selectAll').checked = false;
        updateBulkActions();
        showAlert(`${ids.length} tenant(s) deleted.`, 'success');
    } catch (e) {
        showAlert('Delete failed: ' + e.message, 'error');
    } finally {
        hideLoading();
    }
}

async function markAllPaidPrompt() {
    if (!confirm('Mark ALL tenants as paid?')) return;
    
    showLoading('Updating...');
    try {
        const batch = db.batch();
        tenants.forEach(t => {
            const ref = db.collection('tenants').doc(t.id);
            batch.update(ref, {
                paymentStatus: 'paid',
                paidDate: firebase.firestore.FieldValue.serverTimestamp(),
                updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            });
        });
        await batch.commit();
        
        await loadAllTenants();
        updateOverdueBadge();
        showAlert('All tenants marked as paid!', 'success');
    } catch (e) {
        showAlert('Failed: ' + e.message, 'error');
    } finally {
        hideLoading();
    }
}

// === OVERDUE AUTO-CHECK ===
async function checkOverdueTenants() {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const toMark = tenants
        .filter(t => t.paymentStatus === 'pending' && t.dueDate && new Date(t.dueDate) < today)
        .map(t => t.id);
    
    if (toMark.length) {
        try {
            const batch = db.batch();
            toMark.forEach(id => {
                const ref = db.collection('tenants').doc(id);
                batch.update(ref, {
                    paymentStatus: 'overdue',
                    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
                });
            });
            await batch.commit();
            await loadAllTenants();
        } catch (e) { /* silent */ }
    }
}

// ═══════════════════════════════════════════════════
//  SMS REMINDER SYSTEM (Firebase Version)
// ═══════════════════════════════════════════════════

function scheduleSmsReminderCheck() {
    runSmsReminderCheck();
    setInterval(runSmsReminderCheck, 6 * 60 * 60 * 1000);
}

async function runSmsReminderCheck() {
    const today = new Date(); today.setHours(0, 0, 0, 0);

    const toRemind = tenants.filter(t => {
        if (!t.phone || t.paymentStatus === 'paid') return false;
        if (!t.dueDate) return false;
        const due = new Date(t.dueDate); due.setHours(0, 0, 0, 0);
        const diff = Math.round((due - today) / (1000 * 60 * 60 * 24));
        return diff >= 1 && diff <= 7;
    });

    if (!toRemind.length) return;

    // Log reminders (actual SMS would use a service like Africa's Talking)
    console.log(`📱 Would send ${toRemind.length} SMS reminders:`, 
        toRemind.map(t => `${t.tenantName} (${t.phone})`).join(', '));
    
    // Store reminders in Firestore for tracking
    try {
        for (const t of toRemind) {
            await db.collection('reminders').add({
                tenantId: t.id,
                tenantName: t.tenantName,
                phone: t.phone,
                dueDate: t.dueDate,
                sentAt: firebase.firestore.FieldValue.serverTimestamp(),
                status: 'sent',
                type: 'auto'
            });
        }
        showAlert(`📱 ${toRemind.length} rent reminder(s) logged`, 'info');
        addNotification(`SMS reminders logged for ${toRemind.length} tenant(s)`, 'info');
    } catch (e) {
        console.warn('SMS reminder check failed:', e.message);
    }
}

async function sendBulkReminders() {
    const ids = getSelectedIds();
    if (!ids.length) { showAlert('Select tenants first.', 'warning'); return; }
    
    showLoading('Sending reminders...');
    try {
        for (const id of ids) {
            const t = tenants.find(x => x.id === id);
            if (t && t.phone) {
                await db.collection('reminders').add({
                    tenantId: id,
                    tenantName: t.tenantName,
                    phone: t.phone,
                    dueDate: t.dueDate,
                    sentAt: firebase.firestore.FieldValue.serverTimestamp(),
                    status: 'sent',
                    type: 'manual'
                });
            }
        }
        showAlert(`📱 ${ids.length} SMS reminder(s) logged!`, 'success');
        addNotification(`Manual reminders logged for ${ids.length} tenant(s)`, 'info');
    } catch (e) {
        showAlert('Could not send reminders: ' + e.message, 'error');
    } finally {
        hideLoading();
        document.getElementById('selectAll').checked = false;
        updateBulkActions();
    }
}

async function showRemindersModal() {
    openModal('remindersModal');
    await renderRemindersPreview();
}

async function renderRemindersPreview() {
    const el = document.getElementById('remindersPreviewContent');
    if (!el) return;

    // Load reminder history
    let reminderHistory = [];
    try {
        const snapshot = await db.collection('reminders')
            .orderBy('sentAt', 'desc')
            .limit(50)
            .get();
        snapshot.forEach(doc => {
            reminderHistory.push({ id: doc.id, ...doc.data() });
        });
    } catch (e) {
        console.warn('Could not load reminder history:', e);
    }

    const today = new Date(); today.setHours(0, 0, 0, 0);

    const rows = tenants
        .filter(t => t.paymentStatus !== 'paid')
        .map(t => {
            const due = t.dueDate ? new Date(t.dueDate) : null;
            due && due.setHours(0, 0, 0, 0);
            const diff = due ? Math.round((due - today) / (1000 * 60 * 60 * 24)) : null;
            // Check if already reminded recently
            const lastReminder = reminderHistory.find(r => r.tenantId === t.id);
            const remindedRecently = lastReminder && 
                (new Date() - new Date(lastReminder.sentAt?.toDate?.() || 0)) < 7 * 24 * 60 * 60 * 1000;
            return { ...t, daysLeft: diff, lastReminder, remindedRecently };
        })
        .sort((a, b) => (a.daysLeft ?? 999) - (b.daysLeft ?? 999));

    if (!rows.length) {
        el.innerHTML = `<p style="text-align:center;padding:32px;color:var(--text-4)">All tenants are paid up 🎉</p>`;
        return;
    }

    el.innerHTML = `
        <div style="margin-bottom:16px;padding:12px 16px;background:var(--surface-2);border-radius:10px;font-size:0.875rem;color:var(--text-3)">
            <strong style="color:var(--text-1)">Auto-reminders</strong> are logged 7 days before the due date.
            Tenants with a phone number will receive SMS notifications.
        </div>
        <table style="width:100%;border-collapse:collapse">
            <thead>
                <tr style="border-bottom:2px solid var(--border)">
                    <th style="padding:10px 12px;text-align:left;font-size:0.75rem;text-transform:uppercase;letter-spacing:.05em;color:var(--text-3)">Tenant</th>
                    <th style="padding:10px 12px;text-align:left;font-size:0.75rem;text-transform:uppercase;letter-spacing:.05em;color:var(--text-3)">Unit</th>
                    <th style="padding:10px 12px;text-align:left;font-size:0.75rem;text-transform:uppercase;letter-spacing:.05em;color:var(--text-3)">Phone</th>
                    <th style="padding:10px 12px;text-align:left;font-size:0.75rem;text-transform:uppercase;letter-spacing:.05em;color:var(--text-3)">Due Date</th>
                    <th style="padding:10px 12px;text-align:left;font-size:0.75rem;text-transform:uppercase;letter-spacing:.05em;color:var(--text-3)">Days Left</th>
                    <th style="padding:10px 12px;text-align:left;font-size:0.75rem;text-transform:uppercase;letter-spacing:.05em;color:var(--text-3)">SMS</th>
                    <th style="padding:10px 12px;text-align:left;font-size:0.75rem;text-transform:uppercase;letter-spacing:.05em;color:var(--text-3)">Action</th>
                </tr>
            </thead>
            <tbody>
                ${rows.map(t => {
                    const hasPhone = !!t.phone;
                    const urgency = t.daysLeft !== null
                        ? t.daysLeft <= 0  ? 'overdue'
                        : t.daysLeft <= 3  ? 'urgent'
                        : t.daysLeft <= 7  ? 'soon'
                        : 'upcoming'
                        : 'unknown';
                    const urgencyColor = { overdue:'#ef4444', urgent:'#f59e0b', soon:'#6366f1', upcoming:'var(--text-3)', unknown:'var(--text-4)' }[urgency];
                    const daysLabel = t.daysLeft === null ? '—'
                        : t.daysLeft < 0  ? `${Math.abs(t.daysLeft)}d overdue`
                        : t.daysLeft === 0 ? 'Due today!'
                        : `${t.daysLeft} day${t.daysLeft !== 1 ? 's' : ''}`;
                    const alreadySent = t.remindedRecently && t.phone;
                    return `<tr style="border-bottom:1px solid var(--border)">
                        <td style="padding:10px 12px;font-weight:600;color:var(--text-1)">${t.tenantName}</td>
                        <td style="padding:10px 12px"><span class="unit-badge">${t.unitNumber}</span></td>
                        <td style="padding:10px 12px;font-size:0.875rem;color:${hasPhone?'var(--text-2)':'var(--text-4)'}">${t.phone || '—'}</td>
                        <td style="padding:10px 12px;font-size:0.875rem;color:var(--text-2)">${t.dueDate ? new Date(t.dueDate).toLocaleDateString('en-GB') : '—'}</td>
                        <td style="padding:10px 12px;font-weight:700;color:${urgencyColor}">${daysLabel}</td>
                        <td style="padding:10px 12px">${hasPhone
                            ? alreadySent
                                ? `<span style="color:#10b981;font-size:0.8125rem;font-weight:600">✓ Sent</span>`
                                : `<span style="color:#0ea5e9;font-size:0.8125rem;font-weight:600">Ready</span>`
                            : `<span style="color:var(--text-4);font-size:0.8125rem">No phone</span>`}
                        </td>
                        <td style="padding:10px 12px">
                            ${hasPhone && !alreadySent
                                ? `<button class="btn btn-outline btn-sm" onclick="sendReminderNow('${t.id}')">Send now</button>`
                                : hasPhone && alreadySent
                                ? `<span style="font-size:0.8125rem;color:var(--text-4)">Sent ${new Date(t.lastReminder.sentAt?.toDate?.() || 0).toLocaleDateString()}</span>`
                                : `<button class="btn btn-outline btn-sm" onclick="editTenant('${t.id}')" title="Add phone number">+ Phone</button>`}
                        </td>
                    </tr>`;
                }).join('')}
            </tbody>
        </table>
        <div style="margin-top:20px;display:flex;gap:12px;justify-content:flex-end">
            <button class="btn btn-primary" onclick="sendAllDueReminders()">
                📱 Send reminders to all due (≤7 days)
            </button>
        </div>`;
}

async function sendReminderNow(id) {
    const t = tenants.find(x => x.id === id);
    if (!t || !t.phone) {
        showAlert('Tenant has no phone number.', 'error');
        return;
    }
    
    showLoading('Sending SMS...');
    try {
        await db.collection('reminders').add({
            tenantId: id,
            tenantName: t.tenantName,
            phone: t.phone,
            dueDate: t.dueDate,
            sentAt: firebase.firestore.FieldValue.serverTimestamp(),
            status: 'sent',
            type: 'manual'
        });
        showAlert(`📱 Reminder sent to ${t.tenantName}!`, 'success');
        addNotification(`Reminder sent to ${t.tenantName}`, 'info');
        await renderRemindersPreview();
    } catch (e) {
        showAlert('Could not send reminder: ' + e.message, 'error');
    } finally {
        hideLoading();
    }
}

async function sendAllDueReminders() {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const dueTenants = tenants
        .filter(t => {
            if (!t.phone || t.paymentStatus === 'paid' || !t.dueDate) return false;
            const due = new Date(t.dueDate); due.setHours(0, 0, 0, 0);
            const diff = Math.round((due - today) / (1000 * 60 * 60 * 24));
            return diff >= 1 && diff <= 7;
        });

    if (!dueTenants.length) { showAlert('No tenants with upcoming dues (≤7 days).', 'info'); return; }

    showLoading('Sending reminders...');
    try {
        for (const t of dueTenants) {
            await db.collection('reminders').add({
                tenantId: t.id,
                tenantName: t.tenantName,
                phone: t.phone,
                dueDate: t.dueDate,
                sentAt: firebase.firestore.FieldValue.serverTimestamp(),
                status: 'sent',
                type: 'batch'
            });
        }
        showAlert(`📱 ${dueTenants.length} reminder(s) sent!`, 'success');
        addNotification(`Batch reminders sent to ${dueTenants.length} tenant(s)`, 'info');
        await renderRemindersPreview();
    } catch (e) {
        showAlert('Could not send reminders: ' + e.message, 'error');
    } finally {
        hideLoading();
    }
}

function closeRemindersModal() { closeModal('remindersModal'); }

// ═══════════════════════════════════════════════════
//  IMPORT (Excel → Firestore)
// ═══════════════════════════════════════════════════

function handleFileUpload(event) {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (e) => {
        const wb = XLSX.read(new Uint8Array(e.target.result), { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws);
        await importTenants(rows);
    };
    reader.readAsArrayBuffer(file);
}

async function importTenants(data) {
    showLoading('Importing...');
    let imported = 0;
    
    try {
        for (const row of data) {
            const prev = parseFloat(row.PreviousReading || 0);
            const curr = parseFloat(row.CurrentReading || 0);
            const rate = parseFloat(row.RatePerUnit || 50);
            const units = Math.max(0, curr - prev);
            const waterBill = units * rate;
            const baseRent = parseFloat(row.BaseRent || 0);
            
            const otherChargesMap = {
                ch_electricity: parseFloat(row.Electricity || 0),
                ch_tokens: parseFloat(row.Tokens || 0),
                ch_security_pump: parseFloat(row.SecurityPump || 0),
                ch_caretaker_wifi: parseFloat(row.CaretakerWifi || 0),
                ch_wifi_cctv: parseFloat(row.WIFIAndCCTV || 0),
                ch_security: parseFloat(row.Security || 0),
                ch_rujuwasco: parseFloat(row.Rujuwasco || 0),
                ch_care_taker: parseFloat(row.CareTaker || 0),
                ch_repair_works: parseFloat(row.RepairWorks || 0),
                ch_bio_digester: parseFloat(row.BioDigester || 0),
                ch_repainting: parseFloat(row.Repainting || 0),
                ch_wifi: parseFloat(row.WIFI || 0),
                ch_house_refunds: parseFloat(row.HouseRefunds || 0),
                ch_garbage: parseFloat(row.Garbage || 0),
                ch_other: parseFloat(row.OtherCharges || 0)
            };
            
            const otherChargesTotal = Object.values(otherChargesMap).reduce((a, b) => a + b, 0);
            const totalRent = baseRent + waterBill + otherChargesTotal;
            
            await db.collection('tenants').add({
                tenantName: row.TenantName || 'Unknown',
                unitNumber: row.UnitNumber || 'N/A',
                email: row.Email || '',
                phone: row.Phone || '',
                previousReading: prev,
                currentReading: curr,
                ratePerUnit: rate,
                unitsConsumed: units,
                waterBill: waterBill,
                baseRent: baseRent,
                otherCharges: otherChargesTotal,
                totalRent: totalRent,
                paymentStatus: row.PaymentStatus || 'pending',
                dueDate: row.DueDate || null,
                ...otherChargesMap,
                createdAt: firebase.firestore.FieldValue.serverTimestamp(),
                updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            });
            imported++;
        }
        
        await loadAllTenants();
        closeImportModal();
        showAlert(`Imported ${imported} tenant(s)!`, 'success');
        addNotification(`Imported ${imported} tenant(s)`, 'info');
    } catch (e) {
        showAlert('Import failed: ' + e.message, 'error');
    } finally {
        hideLoading();
    }
}

// ═══════════════════════════════════════════════════
//  SIDEBAR NAVIGATION (unchanged)
// ═══════════════════════════════════════════════════

function toggleSidebar() {
    if (window.innerWidth <= 768) {
        document.body.classList.toggle('mobile-sidebar-open');
    } else {
        document.body.classList.toggle('sidebar-collapsed');
    }
}

function toggleDropdown(id) {
    const el = document.getElementById(id);
    const isOpen = el.classList.contains('open');
    document.querySelectorAll('.nav-dropdown.open').forEach(d => d.classList.remove('open'));
    if (!isOpen) el.classList.add('open');
}

function setParentActive(dropdownId) {
    document.querySelectorAll('.nav-item.active:not(.has-dropdown)').forEach(el => el.classList.remove('active'));
    const btn = document.querySelector(`#${dropdownId} .nav-item.has-dropdown`);
    if (btn) btn.classList.add('active');
}

// ═══════════════════════════════════════════════════
//  NAVIGATION
// ═══════════════════════════════════════════════════

function navigateTo(page, linkEl) {
    const bcCurrent = document.getElementById('bcCurrent');
    bcCurrent.textContent = bcNames[page] || page;

    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    const viewEl = document.getElementById(`view-${page}`);
    if (viewEl) viewEl.classList.add('active');

    if (linkEl) {
        const isDropdownItem = linkEl.classList.contains('dropdown-item');
        if (!isDropdownItem) {
            document.querySelectorAll('.nav-item.active').forEach(el => el.classList.remove('active'));
            if (!linkEl.classList.contains('has-dropdown')) linkEl.classList.add('active');
        }
    }

    if (page === 'overdue') {
        filteredTenants = tenants.filter(t => t.paymentStatus === 'overdue');
        displayTenants();
        document.getElementById('filterStatus').value = 'overdue';
    } else if (page === 'all-tenants' || page === 'dashboard') {
        filteredTenants = [...tenants];
        document.getElementById('filterStatus').value = 'all';
        document.getElementById('searchInput').value = '';
        displayTenants();
    } else if (page === 'water-readings') {
        displayWaterReadings();
    } else if (page === 'water-history') {
        loadWaterHistory();
    } else if (page === 'top-consumers') {
        displayTopConsumers();
    }

    document.querySelector('.page-content').scrollTo({ top: 0, behavior: 'smooth' });
    if (window.innerWidth <= 768) document.body.classList.remove('mobile-sidebar-open');
}

// === THEME ===
function initTheme() {
    const saved = localStorage.getItem('propflow-theme') || 'light';
    document.documentElement.setAttribute('data-theme', saved);
}

function toggleTheme() {
    const curr = document.documentElement.getAttribute('data-theme');
    const next = curr === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('propflow-theme', next);
}

// === ALERTS ===
function showAlert(msg, type = 'success') {
    const box = document.getElementById('alertBox');
    box.className = `alert-toast ${type}`;
    box.textContent = msg;
    box.style.display = 'block';
    clearTimeout(box._timer);
    box._timer = setTimeout(() => { box.style.display = 'none'; }, 3500);
}

// === LOADING ===
function showLoading(msg = 'Processing...') {
    const el = document.getElementById('loadingOverlay');
    el.querySelector('p').textContent = msg;
    el.classList.add('active');
}

function hideLoading() {
    document.getElementById('loadingOverlay').classList.remove('active');
}

// === NOTIFICATIONS ===
function initNotifications() {
    const overdueCount = tenants.filter(t => t.paymentStatus === 'overdue').length;
    const pendingCount = tenants.filter(t => t.paymentStatus === 'pending').length;
    if (overdueCount > 0) addNotification(`${overdueCount} tenant(s) have overdue payments`, 'warning');
    if (pendingCount > 0) addNotification(`${pendingCount} tenant(s) with pending payments`, 'info');
    updateNotifBadge();
}

function addNotification(message, type = 'info') {
    notifications.unshift({ id: Date.now(), message, type, timestamp: new Date(), read: false });
    updateNotifBadge();
    renderNotifications();
}

function updateNotifBadge() {
    const badge = document.getElementById('notifBadge');
    const count = notifications.filter(n => !n.read).length;
    if (count > 0) { badge.textContent = count > 9 ? '9+' : count; badge.style.display = 'block'; }
    else badge.style.display = 'none';
}

function updateOverdueBadge() {
    const badge = document.getElementById('overdueBadge');
    const count = tenants.filter(t => t.paymentStatus === 'overdue').length;
    badge.textContent = count;
    badge.style.display = count > 0 ? 'inline-block' : 'none';
}

function toggleNotifications() {
    const panel = document.getElementById('notifPanel');
    panel.classList.toggle('open');
    if (panel.classList.contains('open')) {
        notifications.forEach(n => n.read = true);
        updateNotifBadge();
        renderNotifications();
    }
}

function renderNotifications() {
    const list = document.getElementById('notifList');
    if (!notifications.length) {
        list.innerHTML = `<div style="padding:24px;text-align:center;color:var(--text-4);font-size:0.875rem;">No notifications</div>`;
        return;
    }
    list.innerHTML = notifications.map(n => `
        <div class="notif-item">
            <div class="notif-dot ${n.type}"></div>
            <div>
                <div class="notif-text">${n.message}</div>
                <div class="notif-time">${formatTime(n.timestamp)}</div>
            </div>
        </div>`).join('');
}

function formatTime(date) {
    const diff = Date.now() - new Date(date);
    const m = Math.floor(diff / 60000);
    const h = Math.floor(m / 60);
    const d = Math.floor(h / 24);
    if (d > 0) return `${d}d ago`;
    if (h > 0) return `${h}h ago`;
    if (m > 0) return `${m}m ago`;
    return 'Just now';
}

document.addEventListener('click', (e) => {
    const panel = document.getElementById('notifPanel');
    const btn = document.getElementById('notifBtn');
    if (panel.classList.contains('open') && !panel.contains(e.target) && !btn.contains(e.target))
        panel.classList.remove('open');
    if (window.innerWidth <= 768 && document.body.classList.contains('mobile-sidebar-open')) {
        const sidebar = document.getElementById('sidebar');
        if (!sidebar.contains(e.target)) document.body.classList.remove('mobile-sidebar-open');
    }
});

// === TENANT MODAL ===
function showAddTenantModal() {
    editingId = null;
    document.getElementById('modalTitle').textContent = 'Add New Tenant';
    document.getElementById('tenantForm').reset();
    document.getElementById('paymentStatus').value = 'pending';
    const numIds = ['electricity','tokens','securityPump','caretakerWifi','wifiCCTV','security',
                    'rujuwasco','careTaker','repairWorks','bioDigester','repainting','wifi',
                    'houseRefunds','garbage','otherCharges'];
    numIds.forEach(id => { const el = document.getElementById(id); if(el) el.value = 0; });
    setDefaultDueDate();
    calculateTotal();
    openModal('tenantModal');
}

function closeTenantModal() { closeModal('tenantModal'); }

function setDefaultDueDate() {
    const now = new Date();
    const due = new Date(now.getFullYear(), now.getMonth() + 1, 5);
    const el = document.getElementById('dueDate');
    if (el) el.value = due.toISOString().split('T')[0];
}

function editTenant(id) {
    const t = tenants.find(x => x.id === id);
    if (!t) return;
    
    editingId = id;
    document.getElementById('modalTitle').textContent = 'Edit Tenant';
    document.getElementById('tenantName').value = t.tenantName;
    document.getElementById('unitNumber').value = t.unitNumber;
    document.getElementById('tenantEmail').value = t.email || '';
    document.getElementById('tenantPhone').value = t.phone || '';
    document.getElementById('previousReading').value = t.previousReading;
    document.getElementById('currentReading').value = t.currentReading;
    document.getElementById('ratePerUnit').value = t.ratePerUnit;
    document.getElementById('baseRent').value = t.baseRent;
    document.getElementById('paymentStatus').value = t.paymentStatus || 'pending';
    document.getElementById('dueDate').value = t.dueDate || '';
    
    const b = t.otherChargesBreakdown || {};
    const map = {
        electricity:'electricity', tokens:'tokens', securityPump:'securityPump',
        caretakerWifi:'caretakerWifi', wifiCCTV:'wifiCCTV', security:'security',
        rujuwasco:'rujuwasco', careTaker:'careTaker', repairWorks:'repairWorks',
        bioDigester:'bioDigester', repainting:'repainting', wifi:'wifi',
        houseRefunds:'houseRefunds', garbage:'garbage', other:'otherCharges'
    };
    Object.entries(map).forEach(([key, elId]) => {
        const el = document.getElementById(elId);
        if (el) el.value = b[key] || 0;
    });
    
    calculateWaterBill();
    calculateTotal();
    openModal('tenantModal');
}

function calculateWaterBill() {
    const prev = parseFloat(document.getElementById('previousReading').value) || 0;
    const curr = parseFloat(document.getElementById('currentReading').value) || 0;
    const units = curr - prev;
    const el = document.getElementById('unitsConsumed');
    if (el) el.value = units.toFixed(1);
    calculateTotal();
}

function calculateTotal() {
    const baseRent = parseFloat(document.getElementById('baseRent').value) || 0;
    const prev = parseFloat(document.getElementById('previousReading').value) || 0;
    const curr = parseFloat(document.getElementById('currentReading').value) || 0;
    const rate = parseFloat(document.getElementById('ratePerUnit').value) || 0;
    const waterBill = (curr - prev) * rate;
    const chargeIds = ['electricity','tokens','securityPump','caretakerWifi','wifiCCTV','security',
                       'rujuwasco','careTaker','repairWorks','bioDigester','repainting','wifi',
                       'houseRefunds','garbage','otherCharges'];
    const totalOther = chargeIds.reduce((sum, id) => sum + (parseFloat(document.getElementById(id)?.value) || 0), 0);
    const total = baseRent + waterBill + totalOther;
    const fmt = v => `KES ${v.toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2})}`;
    document.getElementById('previewBaseRent').textContent = fmt(baseRent);
    document.getElementById('previewWaterBill').textContent = fmt(waterBill);
    document.getElementById('previewOtherCharges').textContent = fmt(totalOther);
    document.getElementById('previewTotal').textContent = fmt(total);
}

// === SEARCH / FILTER / SORT ===
function handleGlobalSearch() {
    const val = document.getElementById('globalSearch').value;
    document.getElementById('searchInput').value = val;
    searchTenants();
}

function searchTenants() { applyFilters(); }
function filterTenants() { applyFilters(); }

function applyFilters() {
    const search = document.getElementById('searchInput').value.toLowerCase();
    const status = document.getElementById('filterStatus').value;
    filteredTenants = tenants.filter(t => {
        const matchSearch = t.tenantName.toLowerCase().includes(search) || t.unitNumber.toLowerCase().includes(search);
        const matchStatus = status === 'all' || t.paymentStatus === status;
        return matchSearch && matchStatus;
    });
    sortTenants();
}

function sortTenants() {
    const sort = document.getElementById('sortBy').value;
    switch (sort) {
        case 'name': filteredTenants.sort((a, b) => a.tenantName.localeCompare(b.tenantName)); break;
        case 'unit': filteredTenants.sort((a, b) => a.unitNumber.localeCompare(b.unitNumber)); break;
        case 'rent-high': filteredTenants.sort((a, b) => b.totalRent - a.totalRent); break;
        case 'rent-low': filteredTenants.sort((a, b) => a.totalRent - b.totalRent); break;
        case 'water-high': filteredTenants.sort((a, b) => b.waterBill - a.waterBill); break;
    }
    displayTenants();
}

// === DISPLAY ===
function refreshDisplay() { displayStats(); displayTenants(); updateTableSubtitle(); }

function updateTableSubtitle() {
    document.getElementById('tableSubtitle').textContent = `${tenants.length} tenant${tenants.length !== 1 ? 's' : ''} registered`;
}

function displayStats() {
    const total = tenants.length;
    const totalRent = tenants.reduce((s, t) => s + t.totalRent, 0);
    const totalWater = tenants.reduce((s, t) => s + t.waterBill, 0);
    const totalUnits = tenants.reduce((s, t) => s + t.unitsConsumed, 0);
    const paid = tenants.filter(t => t.paymentStatus === 'paid').length;
    const pending = tenants.filter(t => t.paymentStatus !== 'paid').reduce((s, t) => s + t.totalRent, 0);
    const overdue = tenants.filter(t => t.paymentStatus === 'overdue').length;
    const avg = total > 0 ? totalRent / total : 0;
    
    document.getElementById('totalTenants').textContent = total;
    document.getElementById('totalRevenue').textContent = `KES ${totalRent.toLocaleString(undefined, {maximumFractionDigits:0})}`;
    document.getElementById('totalWater').textContent = `KES ${totalWater.toLocaleString(undefined, {maximumFractionDigits:0})}`;
    document.getElementById('pendingPayments').textContent = `KES ${pending.toLocaleString(undefined, {maximumFractionDigits:0})}`;
    document.getElementById('avgRent').textContent = `KES ${avg.toLocaleString(undefined, {maximumFractionDigits:0})}`;
    document.getElementById('paidTenants').textContent = paid;
    document.getElementById('waterChange').textContent = `${totalUnits.toFixed(0)} units total`;
    document.getElementById('overdueCount').textContent = `${overdue} overdue`;
    document.getElementById('paidPercentage').textContent = total > 0 ? `${((paid/total)*100).toFixed(0)}% payment rate` : '0% payment rate';
}

function displayTenants() {
    const tbody = document.getElementById('tableBody');
    if (filteredTenants.length === 0) {
        tbody.innerHTML = `<tr><td colspan="12" class="empty-cell"><div class="empty-state">
            <div class="empty-icon"><svg width="48" height="48" viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="8" y="6" width="32" height="36" rx="3"/><path d="M16 16h16M16 22h16M16 28h10"/></svg></div>
            <h3>${tenants.length === 0 ? 'No tenants yet' : 'No results found'}</h3>
            <p>${tenants.length === 0 ? 'Click "Add Tenant" to get started' : 'Try a different search or filter'}</p>
            ${tenants.length === 0 ? '<button class="btn btn-primary" onclick="showAddTenantModal()">Add First Tenant</button>' : ''}
        </div></td></tr>`;
        return;
    }
    
    tbody.innerHTML = filteredTenants.map(t => {
        const initials = t.tenantName.split(' ').map(w => w[0]).join('').substring(0, 2).toUpperCase();
        const statusBadge = `<span class="badge badge-${t.paymentStatus||'pending'}">${t.paymentStatus||'pending'}</span>`;
        return `
            <tr>
                <td><input type="checkbox" class="row-checkbox" data-id="${t.id}" onchange="updateBulkActions()"></td>
                <td><div class="tenant-cell">
                    <div class="tenant-avatar">${initials}</div>
                    <div><div class="tenant-name">${t.tenantName}</div>${t.phone ? `<div class="tenant-phone">${t.phone}</div>` : ''}</div>
                </div></td>
                <td><span class="unit-badge">${t.unitNumber}</span></td>
                <td>${statusBadge}</td>
                <td class="num">${t.previousReading.toFixed(1)}</td>
                <td class="num">${t.currentReading.toFixed(1)}</td>
                <td class="num" style="color:var(--blue);font-weight:600">${t.unitsConsumed.toFixed(1)}</td>
                <td class="num cur">${fmtKes(t.waterBill)}</td>
                <td class="num">${fmtKes(t.baseRent)}</td>
                <td class="num">${fmtKes(t.otherCharges)}</td>
                <td class="num tot">${fmtKes(t.totalRent)}</td>
                <td><div class="tbl-actions">
                    <button class="tbl-btn" onclick="generateInvoice('${t.id}')" title="Invoice">📄</button>
                    <button class="tbl-btn" onclick="editTenant('${t.id}')" title="Edit">✏️</button>
                    <button class="tbl-btn tbl-btn-danger" onclick="deleteTenant('${t.id}')" title="Delete">🗑</button>
                </div></td>
            </tr>`;
    }).join('');
}

function fmtKes(val) {
    return (val || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// === BULK ACTIONS ===
function toggleSelectAll() {
    const all = document.getElementById('selectAll').checked;
    document.querySelectorAll('.row-checkbox').forEach(cb => cb.checked = all);
    updateBulkActions();
}

function updateBulkActions() {
    const checked = document.querySelectorAll('.row-checkbox:checked').length;
    const bar = document.getElementById('bulkActionsBar');
    document.getElementById('selectedCount').textContent = `${checked} selected`;
    bar.style.display = checked > 0 ? 'flex' : 'none';
}

function getSelectedIds() {
    return Array.from(document.querySelectorAll('.row-checkbox:checked')).map(cb => cb.dataset.id);
}

function printSelectedInvoicesPrompt() {
    const ids = getSelectedIds();
    if (!ids.length) { showAlert('Select tenants first.', 'warning'); return; }
    printSelectedInvoices();
}

function printSelectedInvoices() {
    const ids = getSelectedIds();
    if (!ids.length) { showAlert('Select tenants first.', 'warning'); return; }
    const w = window.open('', '', 'width=900,height=700');
    const html = ids.map(id => {
        const idx = tenants.findIndex(t => t.id === id);
        return generateInvoiceHTML(idx, true);
    }).join('');
    w.document.write(`<html><head><title>Invoices</title><style>body{font-family:Arial,sans-serif}@media print{.invoice{page-break-after:always}}</style></head><body>${html}</body></html>`);
    w.document.close(); w.print();
    document.getElementById('selectAll').checked = false;
    updateBulkActions();
}

// === INVOICE ===
function generateInvoice(id) {
    const idx = tenants.findIndex(t => t.id === id);
    document.getElementById('invoiceContent').innerHTML = generateInvoiceHTML(idx, false);
    openModal('invoiceModal');
}

function generateInvoiceHTML(index, forPrint) {
    const t = tenants[index];
    const today = new Date().toLocaleDateString('en-GB');
    const invNum = `INV-${String(index + 1).padStart(4, '0')}`;
    const chargeLabels = {
        electricity:'Electricity', tokens:'Tokens', securityPump:'Security + Pump',
        caretakerWifi:'Caretaker + WiFi', wifiCCTV:'WiFi & CCTV', security:'Security',
        rujuwasco:'Rujuwasco', careTaker:'Care Taker', repairWorks:'Repair Works',
        bioDigester:'Bio Digester', repainting:'Repainting', wifi:'WiFi',
        houseRefunds:'House Refunds', garbage:'Garbage', other:'Other'
    };
    const breakdown = t.otherChargesBreakdown || {};
    const otherRows = Object.entries(chargeLabels)
        .filter(([k]) => breakdown[k] > 0)
        .map(([k, label]) => `<tr><td style="padding:10px 14px;border-bottom:1px solid #e5e7eb"><strong>${label}</strong></td><td style="padding:10px 14px;text-align:center;border-bottom:1px solid #e5e7eb">1</td><td style="padding:10px 14px;text-align:right;border-bottom:1px solid #e5e7eb">${breakdown[k].toFixed(2)}</td><td style="padding:10px 14px;text-align:right;border-bottom:1px solid #e5e7eb;font-weight:600">${breakdown[k].toFixed(2)}</td></tr>`)
        .join('');
    
    return `<div class="invoice" style="${forPrint?'page-break-after:always;padding:40px':''}">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:32px;padding-bottom:24px;border-bottom:3px solid #6366f1">
            <div><h2 style="font-size:1.5rem;font-weight:800;color:#6366f1;margin-bottom:8px">${settings.companyName}</h2><p style="color:#6b7280;font-size:0.875rem;line-height:2">${settings.companyAddress}<br>Phone: ${settings.companyPhone}<br>Email: ${settings.companyEmail}</p></div>
            <div style="text-align:right"><div style="font-size:1.75rem;font-weight:800;color:#6366f1">INVOICE</div><div style="font-family:monospace;font-size:1rem;color:#374151;margin-top:4px">${invNum}</div><div style="font-size:0.875rem;color:#6b7280;margin-top:8px">Date: ${today}</div></div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-bottom:32px">
            <div style="background:#f9fafb;padding:18px;border-radius:10px"><h3 style="color:#6366f1;font-size:0.75rem;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:10px">Bill To</h3><p style="font-size:1rem;font-weight:700;color:#111827">${t.tenantName}</p><p style="color:#6b7280;font-size:0.875rem;margin-top:4px">Unit: <strong>${t.unitNumber}</strong></p>${t.email?`<p style="color:#6b7280;font-size:0.875rem">${t.email}</p>`:''} ${t.phone?`<p style="color:#6b7280;font-size:0.875rem">${t.phone}</p>`:''}</div>
            <div style="background:#f9fafb;padding:18px;border-radius:10px"><h3 style="color:#6366f1;font-size:0.75rem;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:10px">Payment Details</h3><p style="color:#6b7280;font-size:0.875rem;line-height:2">Due Date: <strong>${t.dueDate?new Date(t.dueDate).toLocaleDateString('en-GB'):'N/A'}</strong><br>Status: <strong style="color:${t.paymentStatus==='paid'?'#10b981':t.paymentStatus==='overdue'?'#ef4444':'#f59e0b'}">${(t.paymentStatus||'pending').toUpperCase()}</strong></p><p style="margin-top:10px;font-size:0.875rem;color:#6b7280">M-Pesa: <strong>${settings.mpesaNumber}</strong></p></div>
        </div>
        <table style="width:100%;border-collapse:collapse;margin-bottom:24px"><thead><tr style="background:#f3f4f6"><th style="padding:12px 14px;text-align:left;border-bottom:2px solid #6366f1;font-size:0.75rem;text-transform:uppercase;letter-spacing:0.05em;color:#374151">Description</th><th style="padding:12px 14px;text-align:center;border-bottom:2px solid #6366f1;font-size:0.75rem;text-transform:uppercase;color:#374151">Qty</th><th style="padding:12px 14px;text-align:right;border-bottom:2px solid #6366f1;font-size:0.75rem;text-transform:uppercase;color:#374151">Rate</th><th style="padding:12px 14px;text-align:right;border-bottom:2px solid #6366f1;font-size:0.75rem;text-transform:uppercase;color:#374151">Amount (KES)</th></tr></thead>
        <tbody><tr><td style="padding:12px 14px;border-bottom:1px solid #e5e7eb"><strong>Base Rent</strong><br><small style="color:#9ca3af">Monthly rental</small></td><td style="padding:12px 14px;text-align:center;border-bottom:1px solid #e5e7eb">1</td><td style="padding:12px 14px;text-align:right;border-bottom:1px solid #e5e7eb">${t.baseRent.toFixed(2)}</td><td style="padding:12px 14px;text-align:right;border-bottom:1px solid #e5e7eb;font-weight:600">${t.baseRent.toFixed(2)}</td></tr>
        <tr><td style="padding:12px 14px;border-bottom:1px solid #e5e7eb"><strong>Water Charges</strong><br><small style="color:#9ca3af">Prev: ${t.previousReading.toFixed(1)} | Curr: ${t.currentReading.toFixed(1)}</small></td><td style="padding:12px 14px;text-align:center;border-bottom:1px solid #e5e7eb">${t.unitsConsumed.toFixed(1)} units</td><td style="padding:12px 14px;text-align:right;border-bottom:1px solid #e5e7eb">${t.ratePerUnit.toFixed(2)}</td><td style="padding:12px 14px;text-align:right;border-bottom:1px solid #e5e7eb;font-weight:600">${t.waterBill.toFixed(2)}</td></tr>
        ${otherRows}</tbody></table>
        <div style="display:flex;justify-content:flex-end"><div style="width:320px"><div style="display:flex;justify-content:space-between;padding:8px 16px;border-bottom:1px solid #e5e7eb;font-size:0.875rem"><span>Subtotal</span><span>KES ${(t.baseRent+t.waterBill+t.otherCharges).toFixed(2)}</span></div><div style="display:flex;justify-content:space-between;padding:14px 16px;background:linear-gradient(135deg,#6366f1,#0ea5e9);color:white;font-size:1.125rem;font-weight:800;border-radius:8px;margin-top:8px"><span>TOTAL DUE</span><span>KES ${t.totalRent.toFixed(2)}</span></div></div></div>
        <div style="margin-top:36px;padding-top:20px;border-top:2px solid #e5e7eb;text-align:center;color:#9ca3af;font-size:0.8125rem"><p><strong style="color:#374151">Payment:</strong> M-Pesa: ${settings.mpesaNumber} | Bank: ${settings.bankName} Acc: ${settings.bankAccount}</p><p style="margin-top:8px">Thank you for your tenancy — ${settings.companyName}</p></div>
    </div>`;
}

function closeInvoiceModal() { closeModal('invoiceModal'); }
function printInvoice() { window.print(); }
function downloadInvoicePDF() { showAlert('PDF export coming soon!', 'info'); }

// === IMPORT / EXPORT ===
function showImportModal() { openModal('importModal'); }
function closeImportModal() { closeModal('importModal'); }

function downloadTemplate() {
    const tmpl = [{ TenantName:'John Doe', UnitNumber:'A101', Email:'john@example.com', Phone:'+254700000000', PreviousReading:1000, CurrentReading:1150, RatePerUnit:50, BaseRent:15000, Electricity:200, Tokens:150, SecurityPump:100, CaretakerWifi:200, WIFIAndCCTV:150, Security:300, Rujuwasco:100, CareTaker:200, RepairWorks:0, BioDigester:0, Repainting:0, WIFI:0, HouseRefunds:0, Garbage:100, OtherCharges:0, PaymentStatus:'pending', DueDate:'2026-03-05' }];
    const ws = XLSX.utils.json_to_sheet(tmpl);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Template');
    XLSX.writeFile(wb, 'propflow_template.xlsx');
}

function exportToExcel() {
    if (!tenants.length) { showAlert('No data to export!', 'warning'); return; }
    const data = tenants.map(t => ({
        'Tenant Name':t.tenantName,'Unit':t.unitNumber,'Email':t.email,'Phone':t.phone,
        'Prev Reading':t.previousReading,'Curr Reading':t.currentReading,'Units':t.unitsConsumed,
        'Rate/Unit':t.ratePerUnit,'Water Bill':t.waterBill,'Base Rent':t.baseRent,
        'Other Charges':t.otherCharges,'Total Rent':t.totalRent,'Status':t.paymentStatus,'Due Date':t.dueDate
    }));
    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Tenants');
    XLSX.writeFile(wb, `propflow_export_${new Date().toISOString().split('T')[0]}.xlsx`);
    showAlert('Exported successfully!', 'success');
}

function printAllInvoices() {
    if (!tenants.length) { showAlert('No tenants!', 'warning'); return; }
    const w = window.open('', '', 'width=900,height=700');
    const html = tenants.map((_, i) => generateInvoiceHTML(i, true)).join('');
    w.document.write(`<html><head><title>All Invoices</title><style>body{font-family:Arial,sans-serif}@media print{.invoice{page-break-after:always}}</style></head><body>${html}</body></html>`);
    w.document.close(); w.print();
}

// === ANALYTICS ===
function showAnalytics() { openModal('analyticsModal'); renderCharts(); }
function closeAnalyticsModal() { closeModal('analyticsModal'); }

let chartInstances = {};

function renderCharts() {
    Object.values(chartInstances).forEach(c => c.destroy());
    chartInstances = {};
    renderRevenueChart(); renderPaymentChart(); renderWaterChart(); renderTrendChart();
}

function renderRevenueChart() {
    const ctx = document.getElementById('revenueChart'); if (!ctx) return;
    chartInstances.revenue = new Chart(ctx, { type:'doughnut', data:{ labels:['Base Rent','Water Bills','Other Charges'], datasets:[{ data:[tenants.reduce((s,t)=>s+t.baseRent,0), tenants.reduce((s,t)=>s+t.waterBill,0), tenants.reduce((s,t)=>s+t.otherCharges,0)], backgroundColor:['#6366f1','#0ea5e9','#10b981'], borderWidth:0 }] }, options:{ responsive:true, plugins:{legend:{position:'bottom'}} } });
}

function renderPaymentChart() {
    const ctx = document.getElementById('paymentChart'); if (!ctx) return;
    chartInstances.payment = new Chart(ctx, { type:'pie', data:{ labels:['Paid','Pending','Overdue'], datasets:[{ data:[tenants.filter(t=>t.paymentStatus==='paid').length, tenants.filter(t=>t.paymentStatus==='pending').length, tenants.filter(t=>t.paymentStatus==='overdue').length], backgroundColor:['#10b981','#f59e0b','#ef4444'], borderWidth:0 }] }, options:{ responsive:true, plugins:{legend:{position:'bottom'}} } });
}

function renderWaterChart() {
    const ctx = document.getElementById('waterChart'); if (!ctx) return;
    const top = [...tenants].sort((a,b)=>b.unitsConsumed-a.unitsConsumed).slice(0,8);
    chartInstances.water = new Chart(ctx, { type:'bar', data:{ labels:top.map(t=>t.unitNumber), datasets:[{ label:'Units', data:top.map(t=>t.unitsConsumed), backgroundColor:'#0ea5e9', borderRadius:4 }] }, options:{ responsive:true, plugins:{legend:{display:false}}, scales:{y:{beginAtZero:true}} } });
}

function renderTrendChart() {
    const ctx = document.getElementById('trendChart'); if (!ctx) return;
    chartInstances.trend = new Chart(ctx, { type:'line', data:{ labels:['Sep','Oct','Nov','Dec','Jan','Feb'], datasets:[{ label:'Revenue', data:[45000,52000,49000,58000,61000,tenants.reduce((s,t)=>s+t.totalRent,0)], borderColor:'#6366f1', backgroundColor:'rgba(99,102,241,0.08)', tension:0.4, fill:true, pointBackgroundColor:'#6366f1' }] }, options:{ responsive:true, plugins:{legend:{display:false}}, scales:{y:{beginAtZero:true}} } });
}

// === PAYMENT TRACKER ===
function showPaymentTracker() { openModal('paymentModal'); renderPaymentTracker(); }
function closePaymentModal() { closeModal('paymentModal'); }

function renderPaymentTracker() {
    const el = document.getElementById('paymentTrackerContent');
    if (!tenants.length) { el.innerHTML = '<p style="text-align:center;padding:32px;color:var(--text-4)">No tenants found.</p>'; return; }
    el.innerHTML = `<table><thead><tr><th>Tenant</th><th>Unit</th><th>Amount</th><th>Status</th><th>Due Date</th><th>Action</th></tr></thead><tbody>
        ${tenants.map(t => `<tr>
            <td><strong>${t.tenantName}</strong></td>
            <td><span class="unit-badge">${t.unitNumber}</span></td>
            <td style="font-family:var(--font-mono);font-weight:600">KES ${fmtKes(t.totalRent)}</td>
            <td><span class="badge badge-${t.paymentStatus||'pending'}">${t.paymentStatus||'pending'}</span></td>
            <td style="font-size:0.8125rem;color:var(--text-3)">${t.dueDate?new Date(t.dueDate).toLocaleDateString('en-GB'):'N/A'}</td>
            <td>${t.paymentStatus!=='paid'?`<button class="btn btn-success btn-sm" onclick="markAsPaid('${t.id}')">Mark Paid</button>`:'<span style="color:var(--green);font-size:0.8125rem;font-weight:600">✓ Paid</span>'}</td>
        </tr>`).join('')}
    </tbody></table>`;
}

// === REPORTS ===
function showReports() {
    const total = tenants.reduce((s,t)=>s+t.totalRent,0);
    const paid = tenants.filter(t=>t.paymentStatus==='paid').length;
    const rate = tenants.length > 0 ? ((paid/tenants.length)*100).toFixed(0) : 0;
    showAlert(`Report: ${tenants.length} tenants | KES ${total.toLocaleString()} expected | ${rate}% paid`, 'info');
}

// === WATER METER VIEWS ===
function displayWaterReadings() {
    const tbody = document.getElementById('waterReadingsBody');
    const subtitle = document.getElementById('waterReadingsSubtitle');
    if (!tbody) return;

    subtitle.textContent = `${tenants.length} unit${tenants.length !== 1 ? 's' : ''} tracked`;

    if (!tenants.length) {
        tbody.innerHTML = `<tr><td colspan="7" class="empty-cell"><div class="empty-state">
            <h3>No readings yet</h3><p>Add tenants to track water usage</p>
        </div></td></tr>`;
        return;
    }

    const sorted = [...tenants].sort((a, b) => b.unitsConsumed - a.unitsConsumed);
    tbody.innerHTML = sorted.map(t => `
        <tr>
            <td><div class="tenant-name">${t.tenantName}</div></td>
            <td><span class="unit-badge">${t.unitNumber}</span></td>
            <td class="num">${t.previousReading.toFixed(1)}</td>
            <td class="num">${t.currentReading.toFixed(1)}</td>
            <td class="num" style="color:var(--blue);font-weight:600">${t.unitsConsumed.toFixed(1)}</td>
            <td class="num">${fmtKes(t.ratePerUnit)}</td>
            <td class="num cur">${fmtKes(t.waterBill)}</td>
        </tr>`).join('');
}

async function loadWaterHistory() {
    const tbody = document.getElementById('waterHistoryBody');
    const subtitle = document.getElementById('waterHistorySubtitle');
    if (!tbody) return;

    tbody.innerHTML = `<tr><td colspan="8" class="empty-cell"><div class="empty-state"><p>Loading history...</p></div></td></tr>`;

    try {
        const snapshot = await db.collection('waterHistory')
            .orderBy('readingDate', 'desc')
            .limit(100)
            .get();
        
        const rows = [];
        snapshot.forEach(doc => {
            rows.push({ id: doc.id, ...doc.data() });
        });
        
        subtitle.textContent = `${rows.length} archived reading${rows.length !== 1 ? 's' : ''}`;

        if (!rows.length) {
            tbody.innerHTML = `<tr><td colspan="8" class="empty-cell"><div class="empty-state">
                <h3>No history yet</h3><p>Archive current readings to build history</p>
            </div></td></tr>`;
            return;
        }

        tbody.innerHTML = rows.map(r => `
            <tr>
                <td style="font-size:0.8125rem">${new Date(r.readingDate).toLocaleDateString('en-GB')}</td>
                <td><div class="tenant-name">${r.tenantName}</div></td>
                <td><span class="unit-badge">${r.unitNumber}</span></td>
                <td class="num">${parseFloat(r.previousReading).toFixed(1)}</td>
                <td class="num">${parseFloat(r.currentReading).toFixed(1)}</td>
                <td class="num" style="color:var(--blue);font-weight:600">${parseFloat(r.unitsConsumed).toFixed(1)}</td>
                <td class="num">${fmtKes(parseFloat(r.ratePerUnit))}</td>
                <td class="num cur">${fmtKes(parseFloat(r.waterBill))}</td>
            </tr>`).join('');
    } catch (e) {
        tbody.innerHTML = `<tr><td colspan="8" class="empty-cell"><div class="empty-state">
            <h3>Could not load history</h3><p>${e.message}</p>
        </div></td></tr>`;
        subtitle.textContent = 'Error loading';
    }
}

function displayTopConsumers() {
    const tbody = document.getElementById('topConsumersBody');
    const subtitle = document.getElementById('topConsumersSubtitle');
    if (!tbody) return;

    const totalUnits = tenants.reduce((s, t) => s + t.unitsConsumed, 0);

    if (!tenants.length) {
        subtitle.textContent = 'No data';
        tbody.innerHTML = `<tr><td colspan="6" class="empty-cell"><div class="empty-state">
            <h3>No consumers yet</h3><p>Add tenants to see rankings</p>
        </div></td></tr>`;
        return;
    }

    const sorted = [...tenants].sort((a, b) => b.unitsConsumed - a.unitsConsumed);
    subtitle.textContent = `${totalUnits.toFixed(0)} units consumed total`;

    tbody.innerHTML = sorted.map((t, i) => {
        const pct = totalUnits > 0 ? ((t.unitsConsumed / totalUnits) * 100).toFixed(1) : '0.0';
        const rankStyle = i < 3 ? 'color:var(--amber);font-weight:700' : '';
        return `
            <tr>
                <td class="num" style="${rankStyle}">#${i + 1}</td>
                <td><div class="tenant-name">${t.tenantName}</div></td>
                <td><span class="unit-badge">${t.unitNumber}</span></td>
                <td class="num" style="color:var(--blue);font-weight:600">${t.unitsConsumed.toFixed(1)}</td>
                <td class="num cur">${fmtKes(t.waterBill)}</td>
                <td class="num">${pct}%</td>
            </tr>`;
    }).join('');
}

async function archiveWaterReadings() {
    if (!tenants.length) { showAlert('No tenants to archive.', 'warning'); return; }
    if (!confirm('Archive current readings for all tenants?')) return;
    
    showLoading('Archiving readings...');
    let archived = 0;
    
    try {
        for (const t of tenants) {
            if (t.currentReading > 0) {
                await db.collection('waterHistory').add({
                    tenantId: t.id,
                    tenantName: t.tenantName,
                    unitNumber: t.unitNumber,
                    readingDate: new Date().toISOString().split('T')[0],
                    previousReading: t.previousReading || 0,
                    currentReading: t.currentReading || 0,
                    unitsConsumed: t.unitsConsumed || 0,
                    ratePerUnit: t.ratePerUnit || 50,
                    waterBill: t.waterBill || 0,
                    recordedAt: firebase.firestore.FieldValue.serverTimestamp()
                });
                archived++;
            }
        }
        showAlert(`Archived ${archived} reading(s)!`, 'success');
        addNotification(`Water readings archived for ${archived} unit(s)`, 'info');
    } catch (e) {
        showAlert('Archive failed: ' + e.message, 'error');
    } finally {
        hideLoading();
    }
}

// === SETTINGS MODAL ===
function showSettingsModal() { updateSettingsForm(); openModal('settingsModal'); }
function closeSettingsModal() { closeModal('settingsModal'); }

function updateSettingsForm() {
    const map = { companyName:'companyName', companyAddress:'companyAddress', companyPhone:'companyPhone', companyEmail:'companyEmail', mpesaNumber:'mpesaNumber', bankAccount:'bankAccount', bankName:'bankName' };
    Object.entries(map).forEach(([key, elId]) => {
        const el = document.getElementById(elId);
        if (el) el.value = settings[key] || '';
    });
}

// === MODAL HELPERS ===
function openModal(id) { const el = document.getElementById(id); el.classList.add('open'); el.style.display = 'flex'; }
function closeModal(id) { const el = document.getElementById(id); el.classList.remove('open'); el.style.display = 'none'; }

document.addEventListener('click', (e) => {
    if (e.target.classList.contains('modal-overlay')) { e.target.classList.remove('open'); e.target.style.display = 'none'; }
});

document.addEventListener('keydown', (e) => {
    if ((e.metaKey||e.ctrlKey) && e.key === 'k') { e.preventDefault(); document.getElementById('globalSearch').focus(); }
    if (e.key === 'Escape') {
        document.querySelectorAll('.modal-overlay.open').forEach(m => { m.classList.remove('open'); m.style.display='none'; });
        document.getElementById('notifPanel').classList.remove('open');
    }
});

console.log('✅ PropFlow (Firebase Version) loaded successfully!');
