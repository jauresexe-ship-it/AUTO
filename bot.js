const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const gplay = require('google-play-scraper');

const colors = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    cyan: '\x1b[36m',
    red: '\x1b[31m',
    magenta: '\x1b[35m',
    black: '\x1b[30m',
    bgGreen: '\x1b[42m',
};

const log = {
    info: (msg) => console.log(`${colors.cyan}ℹ${colors.reset} ${msg}`),
    success: (msg) => console.log(`${colors.green}✓${colors.reset} ${msg}`),
    error: (msg) => console.log(`${colors.red}✗${colors.reset} ${msg}`),
    warn: (msg) => console.log(`${colors.yellow}⚠${colors.reset} ${msg}`),
    code: (msg) => console.log(`${colors.bgGreen}${colors.black}${colors.bright} ${msg} ${colors.reset}`),
    magenta: (msg) => console.log(`${colors.magenta}${msg}${colors.reset}`),
};

const MAX_FILE_SIZE_MB = 2048;

const DEVELOPER_INFO = {
    name: 'Omar Xaraf',
    instagram: 'https://instagram.com/Omarxarafp',
    contact: '@Omarxarafp'
};

let sock;
let isConnected = false;
let pairingCodeRequested = false;
let pairingCodeShown = false;
let reconnectAttempts = 0;
let isReconnecting = false;

async function getUserPhoneNumber() {
    const readline = require('readline').createInterface({
        input: process.stdin,
        output: process.stdout
    });

    return new Promise((resolve) => {
        readline.question('Enter your phone number (with country code, e.g., 1234567890): ', (answer) => {
            readline.close();
            resolve(answer);
        });
    });
}

async function connectToWhatsApp() {
    if (isReconnecting) {
        log.warn('إعادة اتصال جارية بالفعل، تم تجاهل المحاولة المكررة');
        return;
    }
    
    isReconnecting = true;
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version, isLatest } = await fetchLatestBaileysVersion();

    if (sock && sock.ev) {
        sock.ev.removeAllListeners();
    }

    sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        auth: state,
        browser: ['Windows', 'Chrome', '1.0.0'],
        connectTimeoutMs: 30000,
        keepAliveIntervalMs: 25000,
        defaultQueryTimeoutMs: 30000,
        retryRequestDelayMs: 150,
        maxMsgRetryCount: 3,
        markOnlineOnConnect: true,
        syncFullHistory: false,
        generateHighQualityLinkPreview: false,
        getMessage: async () => undefined,
    });

    if (!state.creds.registered && !pairingCodeRequested && !pairingCodeShown) {
        pairingCodeRequested = true;
        
        setTimeout(async () => {
            try {
                console.log('\n');
                log.info('Waiting for pairing code...');
                const phoneNumber = process.env.PHONE_NUMBER || await getUserPhoneNumber();

                if (!phoneNumber) {
                    log.error('Phone number is required for pairing');
                    return;
                }

                log.info(`Requesting pairing code for: ${phoneNumber}`);
                const code = await sock.requestPairingCode(phoneNumber.replace(/[^0-9]/g, ''));
                console.log('\n' + '='.repeat(50));
                log.code(`🔑 PAIRING CODE: ${code}`);
                console.log('='.repeat(50) + '\n');
                log.info('Open WhatsApp → Linked Devices → Link with Phone Number');
                log.info('Enter the code above to connect your bot\n');
                log.warn('⏳ Waiting for you to enter the code in WhatsApp...');
                pairingCodeShown = true;
            } catch (error) {
                log.error(`Failed to request pairing code: ${error.message}`);
                pairingCodeRequested = false;
            }
        }, 3000);
    }

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'close') {
            const statusCode = (lastDisconnect?.error)?.output?.statusCode;
            isConnected = false;
            
            if (statusCode === DisconnectReason.loggedOut) {
                if (!sock.authState.creds.registered) {
                    if (pairingCodeShown) {
                        log.warn('⏸️ Still waiting for you to enter the pairing code in WhatsApp...');
                    } else {
                        log.warn('⏸️ Connection closed during pairing - reconnecting...');
                        pairingCodeRequested = false;
                    }
                    
                    setTimeout(() => {
                        isReconnecting = false;
                        connectToWhatsApp();
                    }, 5000);
                } else {
                    log.error('تم تسجيل الخروج');
                    process.exit(0);
                }
            } else {
                if (reconnectAttempts >= 10) {
                    log.error('فشلت محاولات الإعادة المتعددة - توقف الاتصال');
                    isReconnecting = false;
                    setTimeout(() => connectToWhatsApp(), 30000);
                    return;
                }
                
                reconnectAttempts++;
                const delay = Math.min(reconnectAttempts * 3000, 15000);
                log.warn(`انقطاع الاتصال (${reconnectAttempts}) - إعادة بعد ${delay/1000}ث...`);
                
                setTimeout(() => {
                    isReconnecting = false;
                    connectToWhatsApp();
                }, delay);
            }
        } else if (connection === 'open') {
            isConnected = true;
            isReconnecting = false;
            reconnectAttempts = 0;
            console.log('\n');
            log.success('✅ Bot is connected successfully with pairing code!');
            log.info(`👨‍💻 المطور: ${DEVELOPER_INFO.name}\n`);
        } else if (connection === 'connecting') {
            log.info('🔄 جاري الاتصال...');
        }
    });

    sock.ev.on('creds.update', saveCreds);

    const processingMessages = new Set();
    
    sock.ev.on('messages.upsert', async ({ messages }) => {
        if (!isConnected || isReconnecting) {
            return;
        }

        try {
            const m = messages[0];

            if (!m.message || m.key.fromMe || !m.key.remoteJid) return;
            
            if (m.key.remoteJid === 'status@broadcast') return;

            const messageId = m.key.id;
            if (processingMessages.has(messageId)) return;
            processingMessages.add(messageId);

            const messageType = Object.keys(m.message)[0];
            const sender = m.key.remoteJid;

            let textMessage = '';
            if (messageType === 'conversation') {
                textMessage = m.message.conversation;
            } else if (messageType === 'extendedTextMessage') {
                textMessage = m.message.extendedTextMessage.text;
            }

            if (!textMessage || typeof textMessage !== 'string') {
                processingMessages.delete(messageId);
                return;
            }
            
            if (textMessage.includes('Session error') || 
                textMessage.includes('decrypt') || 
                textMessage.includes('Bad MAC') ||
                textMessage.includes('MessageCounterError')) {
                processingMessages.delete(messageId);
                return;
            }

            log.info(`📨 Message from ${sender.split('@')[0]}: ${textMessage}`);

            if (textMessage.toLowerCase() === 'hi' || textMessage.toLowerCase() === 'hello' || textMessage.toLowerCase() === 'السلام عليكم' || textMessage.toLowerCase() === 'مرحبا') {
                const welcomeMessage = `🤖 *بوت تحميل التطبيقات* 🤖\n\n` +
                    `📱 *الاستخدام:* أرسل اسم التطبيق\n\n` +
                    `*مثال:* واتساب، انستقرام، تيك توك، بابجي\n\n` +
                    `✅ يدعم APK و XAPK (مع OBB/Data)\n` +
                    `✅ حجم حتى ${MAX_FILE_SIZE_MB}MB\n` +
                    `🎮 مثالي للألعاب: PUBG, Free Fire, COD\n\n` +
                    `📦 *ملاحظة XAPK:*\n` +
                    `الألعاب الكبيرة تحتاج XAPK Installer للتثبيت\n\n` +
                    `👨‍💻 *المطور:* ${DEVELOPER_INFO.name}\n` +
                    `📲 *انستقرام:* ${DEVELOPER_INFO.instagram}\n\n` +
                    `_by ${DEVELOPER_INFO.contact}_`;

                await sock.sendMessage(sender, { text: welcomeMessage });
                return;
            }

            if (!textMessage.startsWith('/') && textMessage.trim().length > 0) {
                let appName = textMessage.trim();
                
                const arabicToEnglish = {
                    'واتساب': 'whatsapp',
                    'واتس اب': 'whatsapp',
                    'انستقرام': 'instagram',
                    'انستا': 'instagram',
                    'فيسبوك': 'facebook',
                    'فيس بوك': 'facebook',
                    'تيك توك': 'tiktok',
                    'تيكتوك': 'tiktok',
                    'تويتر': 'twitter',
                    'تليجرام': 'telegram',
                    'تلقرام': 'telegram',
                    'سناب شات': 'snapchat',
                    'سناب': 'snapchat',
                    'يوتيوب': 'youtube',
                    'ماسنجر': 'messenger',
                    'مسنجر': 'messenger',
                    'جيميل': 'gmail',
                    'كروم': 'chrome',
                    'خرائط جوجل': 'google maps',
                    'خرائط': 'maps',
                    'بابجي': 'pubg',
                    'فري فاير': 'free fire',
                    'كول اوف ديوتي': 'call of duty',
                    'نتفليكس': 'netflix',
                    'سبوتيفاي': 'spotify',
                    'لايت': 'lite',
                    'ماكس': 'max',
                    'برو': 'pro',
                    'بلس': 'plus',
                    'تطبيق': '',
                    'برنامج': ''
                };
                
                let translatedName = appName.toLowerCase();
                let wasTranslated = false;
                
                for (const [arabic, english] of Object.entries(arabicToEnglish)) {
                    if (translatedName.includes(arabic)) {
                        translatedName = translatedName.replace(new RegExp(arabic, 'g'), english);
                        wasTranslated = true;
                    }
                }
                
                appName = translatedName.replace(/\s+/g, ' ').trim();
                
                if (wasTranslated) {
                    log.info(`🔄 ترجمة: ${textMessage.trim()} → ${appName}`);
                }

                console.log(`${colors.yellow}App Info Requested${colors.reset}`);
                log.info(`🔍 بحث عن: ${appName}`);

                if (!isConnected || isReconnecting) {
                    log.warn('⏸️ تم تأجيل الطلب - البوت يعيد الاتصال');
                    return;
                }
                
                try {
                    // Send searching message immediately
                    await sock.sendMessage(sender, {
                        react: {
                            text: '🔍',
                            key: m.key
                        }
                    });
                    
                    const result = await searchAndDownloadApp(appName);

                    if (!result) {
                        log.error(`No result returned from scraper`);
                        await sock.sendMessage(sender, { text: `❌ فشل في معالجة الطلب. حاول مرة أخرى.\n\n_by @Omarxarafp_` });
                        return;
                    }

                    if (result.error) {
                        log.error(`خطأ: ${result.error}`);
                        if (isConnected && !isReconnecting) {
                            await sock.sendMessage(sender, { text: `❌ ${result.error}\n\n_by ${DEVELOPER_INFO.contact}_` });
                        }
                        return;
                    }

                    if (result.sizeMB && result.sizeMB > MAX_FILE_SIZE_MB) {
                        log.warn(`ملف كبير: ${result.sizeMB} MB`);
                        
                        const filePath = path.join('downloads', result.filename);
                        if (fs.existsSync(filePath)) {
                            setTimeout(() => {
                                try {
                                    if (fs.existsSync(filePath)) {
                                        fs.unlinkSync(filePath);
                                        log.info(`🗑️ تم حذف ${result.filename}`);
                                    }
                                } catch (err) {
                                    log.warn(`فشل حذف الملف: ${result.filename}`);
                                }
                            }, 5000);
                        }
                        
                        await sock.sendMessage(sender, { 
                            text: `⚠️ *الملف كبير جداً!*\n\n` +
                                `📱 ${result.name}\n` +
                                `💾 ${result.size}\n` +
                                `⚠️ الحد الأقصى: ${MAX_FILE_SIZE_MB}MB\n\n` +
                                `_by ${DEVELOPER_INFO.contact}_`
                        });
                        return;
                    }

                    const infoMessage = `📦 *تفاصيل التطبيق*\n\n` +
                        `📱 *الاسم:* ${result.name}\n` +
                        `📦 *الحزمة:* ${result.packageName}\n` +
                        `🔢 *الإصدار:* ${result.version}\n` +
                        `💾 *الحجم:* ${result.size}\n` +
                        `⭐ *التقييم:* ${result.rating || 'N/A'}\n\n` +
                        `⏳ جاري التحميل...\n\n` +
                        `_by ${DEVELOPER_INFO.contact}_`;

                    if (result.icon) {
                        try {
                            const axios = require('axios');
                            const iconResponse = await axios.get(result.icon, { responseType: 'arraybuffer' });
                            await sock.sendMessage(sender, { 
                                image: Buffer.from(iconResponse.data),
                                caption: infoMessage 
                            });
                        } catch (iconError) {
                            await sock.sendMessage(sender, { text: infoMessage });
                        }
                    } else {
                        await sock.sendMessage(sender, { text: infoMessage });
                    }

                    const filePath = path.join('downloads', result.filename);
                    if (!fs.existsSync(filePath)) {
                        log.error(`الملف غير موجود: ${filePath}`);
                        await sock.sendMessage(sender, { text: `❌ فشل العثور على الملف المحمل\n\n_by ${DEVELOPER_INFO.contact}_` });
                        return;
                    }

                    const isXAPK = result.isXapk || 
                                   result.filename.toLowerCase().endsWith('.xapk') || 
                                   result.filename.toLowerCase().endsWith('.apks');

                    const fileType = isXAPK ? 'XAPK' : 'APK';
                    log.success(`📤 إرسال ${fileType}: ${result.filename} (${result.size})`);

                    await sock.sendMessage(sender, {
                        document: fs.readFileSync(filePath),
                        fileName: result.filename,
                        mimetype: 'application/vnd.android.package-archive'
                    });

                    if (isXAPK) {
                        const xapkInstructions = `📦 *ملف XAPK تم إرساله!*\n\n` +
                            `⚠️ *مهم:* هذا الملف يحتوي على بيانات إضافية (OBB/Data)\n` +
                            `مثالي للألعاب الكبيرة مثل PUBG و Free Fire\n\n` +
                            `📲 *طريقة التثبيت:*\n` +
                            `1️⃣ حمّل تطبيق XAPK Installer من متجر بلاي\n` +
                            `2️⃣ افتح التطبيق واختر الملف المحمّل\n` +
                            `3️⃣ اضغط "تثبيت" وانتظر اكتمال التثبيت\n\n` +
                            `✅ *تطبيقات XAPK المقترحة:*\n` +
                            `• XAPK Installer (الأفضل)\n` +
                            `• APKPure App\n` +
                            `• SAI (Split APKs Installer)\n\n` +
                            `_by ${DEVELOPER_INFO.contact}_`;
                        
                        await sock.sendMessage(sender, { text: xapkInstructions });
                    }

                    await sock.sendMessage(sender, {
                        react: {
                            text: '✅',
                            key: m.key
                        }
                    });

                    log.success(`✅ تم الإرسال بنجاح`);

                    setTimeout(() => {
                        try {
                            if (fs.existsSync(filePath)) {
                                fs.unlinkSync(filePath);
                                log.info(`🗑️ تم حذف ${result.filename}`);
                            }
                        } catch (err) {
                            log.warn(`فشل حذف الملف: ${result.filename}`);
                        }
                    }, 10000); // Increased delay to 10 seconds to ensure upload completes

                } catch (error) {
                    log.error(`خطأ في المعالجة: ${error.message}`);
                    if (isConnected && !isReconnecting) {
                        await sock.sendMessage(sender, { 
                            text: `❌ حدث خطأ أثناء معالجة طلبك\n\n_by ${DEVELOPER_INFO.contact}_` 
                        });
                    }
                } finally {
                    processingMessages.delete(messageId);
                }
            }
        } catch (error) {
            log.error(`خطأ في معالجة الرسالة: ${error.message}`);
        }
    });
}

const appCache = new Map();
const CACHE_DURATION = 10 * 60 * 1000; // 10 minutes
const downloadLocks = new Map(); // Prevent concurrent downloads of same file

async function searchAndDownloadApp(appName) {
    return new Promise(async (resolve) => {
        try {
            console.log(`${colors.cyan}Fetching details for the requested app...${colors.reset}`);
            
            // Check cache first
            const cacheKey = appName.toLowerCase();
            const cached = appCache.get(cacheKey);
            if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
                log.info('📦 Using cached app data');
            }
            
            // Check if download is already in progress
            if (downloadLocks.has(cacheKey)) {
                log.warn('⏳ Download already in progress for this app');
                resolve({ error: 'تحميل هذا التطبيق جاري بالفعل، يرجى الانتظار' });
                return;
            }
            
            downloadLocks.set(cacheKey, true);
            
            const searchResults = await gplay.search({
                term: appName,
                num: 1,
                throttle: 1
            });

            if (!searchResults || searchResults.length === 0) {
                resolve({ error: 'لم يتم العثور على التطبيق' });
                return;
            }

            const app = searchResults[0];
            
            let appId = app.appId || app.id;
            
            if (!appId && app.url) {
                const urlMatch = app.url.match(/id=([^&]+)/);
                if (urlMatch) {
                    appId = urlMatch[1];
                }
            }

            if (!appId) {
                log.error(`App ID not found in search results`);
                resolve({ error: 'فشل في الحصول على معرف التطبيق' });
                return;
            }

            log.success(`✓ تم العثور على: ${app.title} (${appId})`);

            const appDetails = await gplay.app({ appId, throttle: 1 });

            log.magenta(`App Version: ${appDetails.version}`);
            log.success(`App Size: ${appDetails.size || 'Unknown'}`);
            
            // Cache the app details
            appCache.set(cacheKey, {
                timestamp: Date.now(),
                appId,
                details: appDetails
            });
            
            console.log(`${colors.red}Connecting to Python scraper...${colors.reset}`);

            const pythonProcess = spawn('python3', ['scraper.py', appId]);

            let output = '';
            let errorOutput = '';

            pythonProcess.stdout.on('data', (data) => {
                output += data.toString();
            });

            pythonProcess.stderr.on('data', (data) => {
                errorOutput += data.toString();
            });

            pythonProcess.on('close', (code) => {
                downloadLocks.delete(cacheKey);
                
                if (code !== 0) {
                    log.error(`Python scraper exited with code ${code}`);
                    resolve({ error: 'فشل تحميل التطبيق' });
                    return;
                }

                const lines = output.trim().split('\n');
                const lastLine = lines[lines.length - 1];

                try {
                    const result = JSON.parse(lastLine);
                    
                    if (result.error) {
                        resolve({ error: result.error });
                        return;
                    }

                    const filePath = result.file_path;
                    const stats = fs.statSync(filePath);
                    const fileSizeInBytes = stats.size;
                    const fileSizeInMB = fileSizeInBytes / (1024 * 1024);

                    resolve({
                        name: appDetails.title,
                        packageName: appId,
                        version: appDetails.version,
                        size: appDetails.size || `${fileSizeInMB.toFixed(2)}MB`,
                        sizeMB: fileSizeInMB,
                        rating: appDetails.scoreText,
                        icon: appDetails.icon || app.icon,
                        filename: path.basename(filePath),
                        isXapk: result.is_xapk || false
                    });

                } catch (parseError) {
                    log.error(`فشل تحليل الإخراج: ${parseError.message}`);
                    resolve({ error: 'خطأ في معالجة البيانات' });
                }
            });

        } catch (error) {
            downloadLocks.delete(cacheKey);
            log.error(`خطأ في البحث: ${error.message}`);
            resolve({ error: 'فشل البحث عن التطبيق' });
        }
    });
}

if (!fs.existsSync('downloads')) {
    fs.mkdirSync('downloads');
}

if (!fs.existsSync('auth_info_baileys')) {
    fs.mkdirSync('auth_info_baileys');
}

connectToWhatsApp();
