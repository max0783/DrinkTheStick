const fs = require('fs');
const { exec } = require('child_process');
const createFile = require('./msc_scrapper_excel');
const TelegramBot = require('node-telegram-bot-api');
const schedule = require('node-schedule');
require('dotenv').config();

const token = process.env.TOKEN;
const bot = new TelegramBot(token, { polling: true });

let users = [];

const saveUsers = () => {
    fs.writeFileSync('users.json', JSON.stringify(users));
};

const loadUsers = () => {
    if (fs.existsSync('users.json')) {
        users = JSON.parse(fs.readFileSync('users.json'));
    }
};

loadUsers();

const sendFileToUsers = async () => {
    try {
        await createFile();
        users.forEach(userId => {
            bot.sendDocument(userId, 'cruceros_msc.xlsx');
        });
    } catch (error) {
        console.error(`Error creating file: ${error}`);
    }
};

const job = schedule.scheduleJob('0 0 * * *', sendFileToUsers);

bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    if (!users.includes(chatId)) {
        users.push(chatId);
        saveUsers();
        bot.sendMessage(chatId, 'You have been registered to receive the file every 24 hours.');
        try {
            await createFile();
            bot.sendDocument(chatId, 'cruceros_msc.xlsx');
        } catch (error) {
            console.error(`Error creating file: ${error}`);
            bot.sendMessage(chatId, 'There was an error creating the file. Please try again later.');
        }
    } else {
        bot.sendMessage(chatId, 'You are already registered.');
    }
});

bot.onText(/\/stop/, (msg) => {
    const chatId = msg.chat.id;
    users = users.filter(userId => userId !== chatId);
    saveUsers();
    bot.sendMessage(chatId, 'You have been unregistered from receiving the file.');
});