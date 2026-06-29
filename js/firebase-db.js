// ============================================
// FIREBASE DATABASE LAYER
// Equivalent to your MySQL schema
// ============================================

// ─── SETTINGS ────────────────────────────────
const SettingsDB = {
    async get() {
        const doc = await db.collection('settings').doc('company').get();
        return doc.exists ? doc.data() : null;
    },
    
    async update(data) {
        await db.collection('settings').doc('company').set({
            ...data,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
    },
    
    // Initialize default settings
    async init() {
        const existing = await this.get();
        if (!existing) {
            await db.collection('settings').doc('company').set({
                companyName: 'JKL PROPERTIES',
                address: 'Nairobi, Kenya',
                phone: '+254 115558365',
                email: 'johnkennedymunjogu@gmail.com',
                mpesaNumber: '0700 000 000',
                bankAccount: '1234567890',
                bankName: 'Equity Bank',
                createdAt: firebase.firestore.FieldValue.serverTimestamp(),
                updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            });
            console.log('✅ Default settings created');
        }
    }
};

// ─── TENANTS ──────────────────────────────────
const TenantsDB = {
    // Create/Add tenant
    async create(data) {
        // Calculate water bill
        const previousReading = parseFloat(data.previousReading) || 0;
        const currentReading = parseFloat(data.currentReading) || 0;
        const ratePerUnit = parseFloat(data.ratePerUnit) || 50;
        const unitsConsumed = Math.max(0, currentReading - previousReading);
        const waterBill = unitsConsumed * ratePerUnit;
        
        // Calculate other charges sum
        const chargeFields = ['ch_electricity', 'ch_tokens', 'ch_repairWorks', 
            'ch_houseRefunds', 'ch_garbage'];
        const otherCharges = chargeFields.reduce((sum, field) => 
            sum + (parseFloat(data[field]) || 0), 0);
        
        // Calculate total rent
        const totalRent = parseFloat(data.baseRent) + waterBill + otherCharges;
        
        const tenantData = {
            tenantName: data.tenantName,
            unitNumber: data.unitNumber,
            phone: data.phone || '',
            
            previousReading: previousReading,
            currentReading: currentReading,
            unitsConsumed: unitsConsumed,
            ratePerUnit: ratePerUnit,
            waterBill: waterBill,
            
            baseRent: parseFloat(data.baseRent),
            paymentStatus: data.paymentStatus || 'pending',
            dueDate: data.dueDate || null,
            
            ch_electricity: parseFloat(data.ch_electricity) || 0,
            ch_tokens: parseFloat(data.ch_tokens) || 0,
            ch_repairWorks: parseFloat(data.ch_repairWorks) || 0,
            ch_houseRefunds: parseFloat(data.ch_houseRefunds) || 0,
            ch_garbage: parseFloat(data.ch_garbage) || 0,
            otherCharges: otherCharges,
            totalRent: totalRent,
            
            createdAt: firebase.firestore.FieldValue.serverTimestamp(),
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        };
        
        const docRef = await db.collection('tenants').add(tenantData);
        return { id: docRef.id, ...tenantData };
    },
    
    // Read all tenants
    async getAll(filters = {}) {
        let query = db.collection('tenants').orderBy('createdAt', 'desc');
        
        // Apply filters
        if (filters.paymentStatus) {
            query = query.where('paymentStatus', '==', filters.paymentStatus);
        }
        if (filters.unitNumber) {
            query = query.where('unitNumber', '==', filters.unitNumber);
        }
        
        const snapshot = await query.get();
        const tenants = [];
        snapshot.forEach(doc => {
            tenants.push({ id: doc.id, ...doc.data() });
        });
        return tenants;
    },
    
    // Read single tenant
    async getById(id) {
        const doc = await db.collection('tenants').doc(id).get();
        if (!doc.exists) return null;
        return { id: doc.id, ...doc.data() };
    },
    
    // Update tenant
    async update(id, data) {
        const docRef = db.collection('tenants').doc(id);
        await docRef.update({
            ...data,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        return await this.getById(id);
    },
    
    // Delete tenant
    async delete(id) {
        await db.collection('tenants').doc(id).delete();
        
        // Also delete associated payments and water history
        const payments = await db.collection('payments')
            .where('tenantId', '==', id).get();
        payments.forEach(doc => doc.ref.delete());
        
        const waterHistory = await db.collection('waterHistory')
            .where('tenantId', '==', id).get();
        waterHistory.forEach(doc => doc.ref.delete());
    },
    
    // Dashboard summary (equivalent to v_dashboard_summary)
    async getDashboardSummary() {
        const tenants = await this.getAll();
        const total = tenants.length;
        const paid = tenants.filter(t => t.paymentStatus === 'paid').length;
        const overdue = tenants.filter(t => t.paymentStatus === 'overdue').length;
        const pending = tenants.filter(t => t.paymentStatus === 'pending').length;
        
        const totalRevenue = tenants.reduce((sum, t) => sum + (t.totalRent || 0), 0);
        const totalWater = tenants.reduce((sum, t) => sum + (t.waterBill || 0), 0);
        const pendingAmount = tenants.filter(t => t.paymentStatus !== 'paid')
            .reduce((sum, t) => sum + (t.totalRent || 0), 0);
        const avgRent = total > 0 ? Math.round(totalRevenue / total) : 0;
        const paymentRate = total > 0 ? Math.round((paid / total) * 100) : 0;
        
        return {
            totalTenants: total,
            totalRevenue: totalRevenue,
            totalWaterBills: totalWater,
            pendingAmount: pendingAmount,
            paidCount: paid,
            overdueCount: overdue,
            pendingCount: pending,
            avgRent: avgRent,
            paymentRate: paymentRate
        };
    },
    
    // Top water consumers (equivalent to v_top_water_consumers)
    async getTopWaterConsumers(limit = 10) {
        const tenants = await this.getAll();
        return tenants
            .filter(t => t.unitsConsumed > 0)
            .sort((a, b) => b.unitsConsumed - a.unitsConsumed)
            .slice(0, limit)
            .map(t => ({
                id: t.id,
                tenantName: t.tenantName,
                unitNumber: t.unitNumber,
                unitsConsumed: t.unitsConsumed,
                waterBill: t.waterBill
            }));
    }
};

// ─── PAYMENT HISTORY ──────────────────────────
const PaymentsDB = {
    async create(data) {
        const paymentData = {
            tenantId: data.tenantId,
            tenantName: data.tenantName,
            unitNumber: data.unitNumber,
            amountPaid: parseFloat(data.amountPaid),
            paymentDate: data.paymentDate || new Date().toISOString().split('T')[0],
            method: data.method || 'M-Pesa',
            reference: data.reference || '',
            notes: data.notes || '',
            recordedAt: firebase.firestore.FieldValue.serverTimestamp()
        };
        
        const docRef = await db.collection('payments').add(paymentData);
        
        // Update tenant payment status to 'paid'
        await TenantsDB.update(data.tenantId, { paymentStatus: 'paid' });
        
        return { id: docRef.id, ...paymentData };
    },
    
    async getByTenant(tenantId) {
        const snapshot = await db.collection('payments')
            .where('tenantId', '==', tenantId)
            .orderBy('paymentDate', 'desc')
            .get();
        
        const payments = [];
        snapshot.forEach(doc => {
            payments.push({ id: doc.id, ...doc.data() });
        });
        return payments;
    },
    
    async getAll() {
        const snapshot = await db.collection('payments')
            .orderBy('paymentDate', 'desc')
            .get();
        
        const payments = [];
        snapshot.forEach(doc => {
            payments.push({ id: doc.id, ...doc.data() });
        });
        return payments;
    },
    
    async delete(id) {
        await db.collection('payments').doc(id).delete();
    }
};

// ─── WATER METER HISTORY ─────────────────────
const WaterHistoryDB = {
    async create(data) {
        const historyData = {
            tenantId: data.tenantId,
            tenantName: data.tenantName,
            unitNumber: data.unitNumber,
            readingDate: data.readingDate || new Date().toISOString().split('T')[0],
            previousReading: parseFloat(data.previousReading),
            currentReading: parseFloat(data.currentReading),
            unitsConsumed: parseFloat(data.currentReading) - parseFloat(data.previousReading),
            ratePerUnit: parseFloat(data.ratePerUnit) || 50,
            waterBill: (parseFloat(data.currentReading) - parseFloat(data.previousReading)) * (parseFloat(data.ratePerUnit) || 50),
            recordedAt: firebase.firestore.FieldValue.serverTimestamp()
        };
        
        const docRef = await db.collection('waterHistory').add(historyData);
        return { id: docRef.id, ...historyData };
    },
    
    async getByTenant(tenantId) {
        const snapshot = await db.collection('waterHistory')
            .where('tenantId', '==', tenantId)
            .orderBy('readingDate', 'desc')
            .get();
        
        const history = [];
        snapshot.forEach(doc => {
            history.push({ id: doc.id, ...doc.data() });
        });
        return history;
    },
    
    async archiveCurrentReadings() {
        const tenants = await TenantsDB.getAll();
        const results = [];
        
        for (const tenant of tenants) {
            if (tenant.currentReading > 0) {
                const result = await this.create({
                    tenantId: tenant.id,
                    tenantName: tenant.tenantName,
                    unitNumber: tenant.unitNumber,
                    readingDate: new Date().toISOString().split('T')[0],
                    previousReading: tenant.previousReading || 0,
                    currentReading: tenant.currentReading || 0,
                    ratePerUnit: tenant.ratePerUnit || 50
                });
                results.push(result);
            }
        }
        return results;
    }
};

// ============================================
// EXPOSE TO GLOBAL SCOPE
// ============================================
window.SettingsDB = SettingsDB;
window.TenantsDB = TenantsDB;
window.PaymentsDB = PaymentsDB;
window.WaterHistoryDB = WaterHistoryDB;

console.log('✅ Firebase Database Layer initialized');
console.log('📁 Collections: settings, tenants, payments, waterHistory');
