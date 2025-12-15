// This function acts as a secure backend proxy to call the Gemini API,
// hiding the GEMINI_API_KEY from the client-side code.

const API_KEY = process.env.GEMINI_API_KEY;
const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${API_KEY}`;
const MAX_RETRIES = 3;

/**
 * Generic sleep function for exponential backoff.
 * @param {number} ms - Milliseconds to sleep.
 */
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Netlify serverless function handler.
 * @param {object} event - The event object from Netlify.
 * @returns {object} The response object.
 */
exports.handler = async (event) => {
    // 1. Security Check: Only allow POST requests
    if (event.httpMethod !== 'POST') {
        return {
            statusCode: 405,
            body: JSON.stringify({ message: "Method Not Allowed. Use POST." }),
        };
    }

    // 2. CRITICAL API Key Check - Updated to return a clearer status code/message
    if (!API_KEY) {
        console.error("CRITICAL ERROR: GEMINI_API_KEY environment variable is not set in Netlify settings.");
        return {
            // Using 503 Service Unavailable to indicate a server misconfiguration
            statusCode: 503, 
            body: JSON.stringify({ 
                message: "Server configuration error: GEMINI_API_KEY is missing. Please set it in Netlify Environment Variables." 
            }),
        };
    }

    let clientPayload;
    try {
        // 3. Parse the incoming body (from the client-side HTML)
        clientPayload = JSON.parse(event.body);
    } catch (e) {
        return {
            statusCode: 400,
            body: JSON.stringify({ message: "Invalid JSON body received." }),
        };
    }

    const userPrompt = clientPayload.prompt;

    if (!userPrompt) {
        return {
            statusCode: 400,
            body: JSON.stringify({ message: "Missing 'prompt' in request body." }),
        };
    }

    // 4. Construct the full Gemini API payload (including system instruction and tools)
    const systemPrompt = "You are a helpful and knowledgeable guide on Islamic principles and services. Answer the user's query concisely and accurately based on the most current information available, using markdown for formatting.";
    
    const geminiPayload = {
        contents: [{ parts: [{ text: userPrompt }] }],
        // Enable Google Search grounding
        tools: [{ "google_search": {} }],
        systemInstruction: {
            parts: [{ text: systemPrompt }]
        },
    };


    // 5. Call the Gemini API with exponential backoff
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
            const response = await fetch(API_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(geminiPayload)
            });

            if (response.status === 429) {
                // Rate limit exceeded, apply exponential backoff
                const delay = Math.pow(2, attempt) * 1000 + Math.random() * 500;
                if (attempt < MAX_RETRIES - 1) {
                    await sleep(delay);
                    continue; // Retry
                } else {
                    return {
                        statusCode: 429,
                        body: JSON.stringify({ message: "Rate limit exceeded on external API." }),
                    };
                }
            }

            if (!response.ok) {
                const errorText = await response.text();
                // If the response is not OK, log the error and break retries
                console.error(`External API failed: Status ${response.status}. Response: ${errorText}`);
                throw new Error(`External API failed with status: ${response.status}.`);
            }

            const result = await response.json();
            const candidate = result.candidates?.[0];

            if (candidate && candidate.content?.parts?.[0]?.text) {
                const text = candidate.content.parts[0].text;
                let sources = [];
                const groundingMetadata = candidate.groundingMetadata;

                if (groundingMetadata && groundingMetadata.groundingAttributions) {
                    sources = groundingMetadata.groundingAttributions
                        .map(attribution => ({
                            uri: attribution.web?.uri,
                            title: attribution.web?.title,
                        }))
                        .filter(source => source.uri && source.title);
                }
                
                // 6. Return only the necessary data back to the client
                return {
                    statusCode: 200,
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ text, sources }),
                };
            } else {
                return {
                    statusCode: 500,
                    body: JSON.stringify({ message: "API returned an empty or malformed response." }),
                };
            }

        } catch (error) {
            console.error(`Gemini Proxy Execution Error on attempt ${attempt + 1}:`, error.message);
            if (attempt === MAX_RETRIES - 1) {
                 return {
                    statusCode: 500,
                    body: JSON.stringify({ message: `Internal server error after ${MAX_RETRIES} attempts. Check Netlify function logs for details.` }),
                };
            }
        }
    }
};
