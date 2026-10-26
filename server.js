const express = require('express');
const multer = require('multer');
const puppeteer = require('puppeteer');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
const upload = multer({ dest: 'uploads/' });

app.use(express.static('public'));

// Extractor helper to sanitize codes from full URLs
function cleanMeetCode(input) {
    const match = input.match(/meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})/i);
    return match ? match[1] : input.trim();
}

app.post('/run-bot', upload.single('audio'), async (req, res) => {
    // Set headers for streaming text updates down to the frontend layout
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Transfer-Encoding', 'chunked');

    const sendUpdate = (obj) => res.write(JSON.stringify(obj) + '\n');

    if (!req.file || !req.body.meetUrl || !req.body.botName) {
        sendUpdate({ status: 'error', message: 'Missing parameters or invalid file form data.' });
        return res.end();
    }

    const meetingCode = cleanMeetCode(req.body.meetUrl);
    const botName = req.body.botName;
    const audioPath = req.file.path;

    let browser;
    try {
        sendUpdate({ status: 'navigating' });

        browser = await puppeteer.launch({
            headless: true,
            args: [
                '--use-fake-ui-for-media-stream',
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage'
            ]
        });

        const page = await browser.newPage();
        await page.goto(`https://google.com{meetingCode}`, { waitUntil: 'networkidle2' });

        // Enter Bot Name
        await page.waitForSelector('input[type="text"]');
        await page.type('input[type="text"]', botName);

        // Track and click whichever button exists: "Join now" (Open Room) or "Ask to join" (Closed Lobby)
        // Meet structures can vary depending on layout configs. We evaluate innerText contents.
        const targetBtn = await page.evaluateHandle(() => {
            const buttons = Array.from(document.querySelectorAll('button'));
            return buttons.find(b => b.innerText.includes('Join now') || b.innerText.includes('Ask to join')) || null;
        });

        if (!targetBtn.asElement()) {
            throw new Error("Unable to identify Meet entrance interactive buttons.");
        }

        const buttonText = await page.evaluate(el => el.innerText, targetBtn);
        await targetBtn.click();

        let sessionState = 'lobby';
        
        if (buttonText.includes('Join now')) {
            // Instantly inside an open room
            sessionState = 'inside';
            sendUpdate({ status: 'joined_direct' });
        } else {
            // Standard restricted room requires knocking loops
            sendUpdate({ status: 'knocking' });
            
            // Loop evaluation to check if admitted, rejected, or timed out
            for (let i = 0; i < 90; i++) { // Wait up to 90 seconds
                await new Promise(r => setTimeout(r, 1000));
                
                // If a termination element or leave button exists, the bot successfully entered
                const admittedCheck = await page.$('button[aria-label="Leave call"]');
                if (admittedCheck) {
                    sessionState = 'inside';
                    sendUpdate({ status: 'admitted' });
                    break;
                }

                // Check if rejected message banner or screen layout resets back to base portal
                const currentUrl = page.url();
                if (currentUrl.includes('landing') || await page.evaluate(() => document.body.innerText.includes("Someone in the meeting wouldn't let you in"))) {
                    sessionState = 'rejected';
                    sendUpdate({ status: 'rejected' });
                    break;
                }
            }
        }

        if (sessionState !== 'inside') {
            if (sessionState === 'lobby') sendUpdate({ status: 'error', message: 'Lobby connection window timed out without response.' });
            await browser.close();
            fs.unlinkSync(audioPath);
            return res.end();
        }

        // Execute Audio Processing Injection Pipeline
        sendUpdate({ status: 'playing' });
        const playback = exec(`ffmpeg -re -i ${audioPath} -f alsa VirtualSpeaker`);

        playback.on('close', async () => {
            sendUpdate({ status: 'done' });
            try { await browser.close(); } catch(e){}
            fs.unlinkSync(audioPath); // Garbage collect the temp uploaded file path
            res.end();
        });

    } catch (err) {
        sendUpdate({ status: 'error', message: err.message });
        if (browser) await browser.close();
        if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
        res.end();
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on standard port ${PORT}`));

