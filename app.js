const fs = require('fs');
const { exec } = require('child_process');
const createFile = require('./msc_scrapper_excel');
const TelegramBot = require('node-telegram-bot-api');
const schedule = require('node-schedule');
require('dotenv').config();

// Configuración del bot
const token = process.env.TOKEN;
const bot = new TelegramBot(token, { polling: true });

// Variables para manejar usuarios y ofertas enviadas
let users = [];
let sentOffers = [];

// Funciones de persistencia
const saveUsers = () => {
    fs.writeFileSync('users.json', JSON.stringify(users));
};

const loadUsers = () => {
    if (fs.existsSync('users.json')) {
        users = JSON.parse(fs.readFileSync('users.json'));
    }
};

const saveSentOffers = () => {
    fs.writeFileSync('sent_offers.json', JSON.stringify(sentOffers));
};

const loadSentOffers = () => {
    if (fs.existsSync('sent_offers.json')) {
        sentOffers = JSON.parse(fs.readFileSync('sent_offers.json'));
    }
};

// Cargar datos guardados
loadUsers();
loadSentOffers();

// Función para verificar y notificar ofertas
const checkAndNotifyOffers = async () => {
    try {
        await createFile();
        
        // Leer el archivo JSON generado
        const crucerosData = JSON.parse(fs.readFileSync('cruceros_msc.json', 'utf8'));
        
        // Obtener ofertas actuales menores o iguales a 500
        const currentOffers = crucerosData.cruceros
            .filter(crucero => {
                const precio = parseInt(crucero.precio.valor);
                return precio <= 500;
            })
            .map(crucero => ({
                destino: crucero.destino,
                duracion: crucero.duracion,
                barco: crucero.barco,
                precio: parseInt(crucero.precio.valor),
                moneda: crucero.precio.moneda,
                fechas: crucero.fechas_disponibles.join(', '),
                url: crucero.url_itinerario,
                puerto: crucero.puerto_salida,
                page: crucero.pagina
            }));

        // Limpiar ofertas que ya no están disponibles
        sentOffers = sentOffers.filter(sentOffer => 
            currentOffers.some(currentOffer => 
                currentOffer.destino === sentOffer.destino &&
                currentOffer.precio === sentOffer.precio &&
                currentOffer.fechas === sentOffer.fechas
            )
        );
        
        // Encontrar nuevas ofertas
        const newOffers = currentOffers.filter(currentOffer => 
            !sentOffers.some(sentOffer =>
                currentOffer.destino === sentOffer.destino &&
                currentOffer.precio === sentOffer.precio &&
                currentOffer.fechas === sentOffer.fechas
            )
        );
        
        // Enviar notificaciones para nuevas ofertas
        if (newOffers.length > 0) {
            for (const offer of newOffers) {
                const message = `¡Nueva oferta encontrada!\n\n` +
                              `🚢 Destino: ${offer.destino}\n` +
                              `⏱ Duración: ${offer.duracion}\n` +
                              `🛳 Barco: ${offer.barco}\n` +
                              `🌊 Puerto de salida: ${offer.puerto}\n` +
                              `💰 Precio: ${offer.precio} ${offer.moneda}\n` +
                              `📅 Fechas disponibles: ${offer.fechas}\n` +
                              `🔗 Ver más: ${offer.url || `https://www.msccruceros.com.ar/ofertas-cruceros/cruceros-a-brasil?departureDateFrom=12%2F01%2F2024&departureDateTo=30%2F04%2F2026&passengers=2%7C0%7C0%7C0&area=SOA&embkPort=BUE%2CMVD&ships=PO%2CAX%2CSP%2CFA%2CPR&page=${offer.page}` }`;
                
                // Enviar a todos los usuarios suscritos
                for (const userId of users) {
                    try {
                        await bot.sendMessage(userId, message);
                    } catch (error) {
                        console.error(`Error sending message to user ${userId}:`, error);
                    }
                }
                
                // Agregar a ofertas enviadas
                sentOffers.push(offer);
            }
            
            // Guardar ofertas enviadas actualizadas
            saveSentOffers();
        }
        
    } catch (error) {
        console.error(`Error checking offers:`, error);
    }
};

// Programar verificación cada 30 minutos
const job = schedule.scheduleJob('*/15 * * * *', checkAndNotifyOffers);

// Comandos del bot
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    if (!users.includes(chatId)) {
        users.push(chatId);
        saveUsers();
        bot.sendMessage(chatId, '¡Te has registrado para recibir notificaciones de ofertas de cruceros! Te avisaré cuando encuentre ofertas menores o iguales a $500 USD.');
        
        // Verificar ofertas inmediatamente
        await checkAndNotifyOffers();
    } else {
        bot.sendMessage(chatId, 'Ya estás registrado para recibir notificaciones.');
    }
});

bot.onText(/\/stop/, (msg) => {
    const chatId = msg.chat.id;
    users = users.filter(userId => userId !== chatId);
    saveUsers();
    bot.sendMessage(chatId, 'Te has dado de baja de las notificaciones de ofertas.');
});

// Comando para ver ofertas actuales
bot.onText(/\/offers/, async (msg) => {
    const chatId = msg.chat.id;
    if (sentOffers.length > 0) {
        let message = '📢 Ofertas actuales menores a $500 USD:\n\n';
        sentOffers.forEach((offer, index) => {
            message += `${index + 1}. ${offer.destino}\n` +
                      `   💰 Precio: ${offer.precio} ${offer.moneda}\n` +
                      `   ⏱ Duración: ${offer.duracion}\n` +
                      `   🛳 Barco: ${offer.barco}\n` +
                      `   🌊 Puerto: ${offer.puerto}\n\n`;
        });
        bot.sendMessage(chatId, message);
    } else {
        bot.sendMessage(chatId, '❌ No hay ofertas activas menores a $500 USD en este momento.');
    }
});