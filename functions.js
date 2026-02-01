const { app } = require('@azure/functions');
const { TableClient, AzureNamedKeyCredential } = require('@azure/data-tables');
const jwt = require('jsonwebtoken');

// Configuration
const APP_STORE_KEY_ID = process.env.APP_STORE_KEY_ID;
const APP_STORE_ISSUER_ID = process.env.APP_STORE_ISSUER_ID;
const APP_STORE_PRIVATE_KEY = process.env.APP_STORE_PRIVATE_KEY;
const APP_BUNDLE_ID = process.env.APP_ID; // e.g., jp.tech.kotoba.app
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
const AZURE_STORAGE_ACCOUNT = process.env.AZURE_STORAGE_ACCOUNT;
const AZURE_STORAGE_KEY = process.env.AZURE_STORAGE_KEY;

const TABLE_NAME = 'appstorereviews';

// Generate JWT token for App Store Connect API
function generateToken() {
    const now = Math.floor(Date.now() / 1000);
    const payload = {
        iss: APP_STORE_ISSUER_ID,
        iat: now,
        exp: now + 20 * 60, // 20 minutes
        aud: 'appstoreconnect-v1'
    };

    // Handle private key - replace literal \n with actual newlines
    const privateKey = APP_STORE_PRIVATE_KEY.replace(/\\n/g, '\n');

    return jwt.sign(payload, privateKey, {
        algorithm: 'ES256',
        keyid: APP_STORE_KEY_ID
    });
}

// Get Table Storage client
function getTableClient() {
    const credential = new AzureNamedKeyCredential(AZURE_STORAGE_ACCOUNT, AZURE_STORAGE_KEY);
    return new TableClient(
        `https://${AZURE_STORAGE_ACCOUNT}.table.core.windows.net`,
        TABLE_NAME,
        credential
    );
}

// Look up app by bundle ID to get the Apple ID
async function getAppId(token, context) {
    const response = await fetch(
        `https://api.appstoreconnect.apple.com/v1/apps?filter[bundleId]=${APP_BUNDLE_ID}`,
        {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            }
        }
    );

    if (!response.ok) {
        const error = await response.text();
        throw new Error(`Failed to fetch app: ${response.status} - ${error}`);
    }

    const data = await response.json();
    if (!data.data || data.data.length === 0) {
        throw new Error(`App not found with bundle ID: ${APP_BUNDLE_ID}`);
    }

    return data.data[0].id;
}

// Fetch customer reviews from App Store Connect API
async function fetchReviews(token, appId, context) {
    const reviews = [];
    let nextUrl = `https://api.appstoreconnect.apple.com/v1/apps/${appId}/customerReviews?sort=-createdDate&limit=50`;

    while (nextUrl) {
        context.log(`Fetching reviews from: ${nextUrl}`);
        
        const response = await fetch(nextUrl, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Failed to fetch reviews: ${response.status} - ${error}`);
        }

        const data = await response.json();
        reviews.push(...(data.data || []));

        // Get next page if available (limit to recent reviews)
        nextUrl = data.links?.next;
        
        // Stop after first page for daily runs (50 reviews should be plenty)
        if (reviews.length >= 50) break;
    }

    return reviews;
}

// Check if review has already been posted
async function isReviewPosted(tableClient, reviewId) {
    try {
        await tableClient.getEntity('reviews', reviewId);
        return true;
    } catch (e) {
        return false;
    }
}

// Mark review as posted
async function markReviewPosted(tableClient, review) {
    const entity = {
        partitionKey: 'reviews',
        rowKey: review.id,
        reviewId: review.id,
        rating: review.attributes.rating,
        title: review.attributes.title || '',
        body: review.attributes.body || '',
        reviewerNickname: review.attributes.reviewerNickname || 'Anonymous',
        territory: review.attributes.territory || '',
        createdDate: review.attributes.createdDate,
        postedAt: new Date().toISOString()
    };

    await tableClient.upsertEntity(entity, 'Replace');
}

// Format star rating as emoji
function formatStars(rating) {
    const filled = '★'.repeat(rating);
    const empty = '☆'.repeat(5 - rating);
    return filled + empty;
}

// Post review to Slack
async function postToSlack(review, context) {
    const { rating, title, body, reviewerNickname, territory, createdDate } = review.attributes;
    
    // Color based on rating
    const color = rating >= 4 ? '#36a64f' : rating >= 3 ? '#daa038' : '#dc3545';
    
    const message = {
        attachments: [
            {
                color: color,
                blocks: [
                    {
                        type: 'section',
                        text: {
                            type: 'mrkdwn',
                            text: `*${formatStars(rating)}* ${rating}/5\n${title ? `*${title}*\n` : ''}${body || '_No review text_'}`
                        }
                    },
                    {
                        type: 'context',
                        elements: [
                            {
                                type: 'mrkdwn',
                                text: `👤 ${reviewerNickname || 'Anonymous'} • 🌍 ${territory || 'Unknown'} • 📅 ${new Date(createdDate).toLocaleDateString()}`
                            }
                        ]
                    }
                ]
            }
        ]
    };

    const response = await fetch(SLACK_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(message)
    });

    if (!response.ok) {
        throw new Error(`Slack webhook failed: ${response.status}`);
    }
}

// Post summary header to Slack
async function postSummaryHeader(newReviewCount, context) {
    const message = {
        blocks: [
            {
                type: 'header',
                text: {
                    type: 'plain_text',
                    text: `📱 ${newReviewCount} New App Store Review${newReviewCount === 1 ? '' : 's'}`,
                    emoji: true
                }
            },
            {
                type: 'context',
                elements: [
                    {
                        type: 'mrkdwn',
                        text: `*${APP_BUNDLE_ID}* • ${new Date().toLocaleDateString()}`
                    }
                ]
            },
            { type: 'divider' }
        ]
    };

    const response = await fetch(SLACK_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(message)
    });

    if (!response.ok) {
        throw new Error(`Slack webhook failed: ${response.status}`);
    }
}

// Main function to check for new reviews and post them
async function checkAndPostReviews(context, options = {}) {
    const { preview = false, forcePost = false } = options;
    
    context.log('Starting review check...');

    // Generate token
    const token = generateToken();
    context.log('Generated App Store Connect API token');

    // Get app ID from bundle ID
    const appId = await getAppId(token, context);
    context.log(`Found app ID: ${appId} for bundle ID: ${APP_BUNDLE_ID}`);

    // Fetch reviews
    const reviews = await fetchReviews(token, appId, context);
    context.log(`Fetched ${reviews.length} reviews`);

    if (preview) {
        // Preview mode - return formatted data without posting
        return reviews.map(r => ({
            id: r.id,
            rating: r.attributes.rating,
            title: r.attributes.title,
            body: r.attributes.body,
            reviewer: r.attributes.reviewerNickname,
            territory: r.attributes.territory,
            createdDate: r.attributes.createdDate
        }));
    }

    // Get table client for tracking posted reviews
    let tableClient = null;
    if (AZURE_STORAGE_ACCOUNT && AZURE_STORAGE_KEY) {
        tableClient = getTableClient();
        await tableClient.createTable().catch(() => {}); // Ignore if exists
    } else {
        context.log('Warning: Azure Storage not configured - all reviews will be posted');
    }

    // Filter to only new reviews
    const newReviews = [];
    for (const review of reviews) {
        if (tableClient && !forcePost) {
            const alreadyPosted = await isReviewPosted(tableClient, review.id);
            if (!alreadyPosted) {
                newReviews.push(review);
            }
        } else {
            newReviews.push(review);
        }
    }

    context.log(`Found ${newReviews.length} new reviews to post`);

    if (newReviews.length === 0) {
        return { message: 'No new reviews to post', reviewCount: 0 };
    }

    // Post header
    await postSummaryHeader(newReviews.length, context);

    // Post each review (newest last so they appear in order)
    const sortedReviews = newReviews.sort((a, b) => 
        new Date(a.attributes.createdDate) - new Date(b.attributes.createdDate)
    );

    for (const review of sortedReviews) {
        await postToSlack(review, context);
        
        // Mark as posted
        if (tableClient) {
            await markReviewPosted(tableClient, review);
        }
        
        context.log(`Posted review: ${review.id}`);
        
        // Small delay between posts to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 500));
    }

    return { message: `Posted ${newReviews.length} new reviews`, reviewCount: newReviews.length };
}

// Timer Trigger: Runs daily at 9am JST (0:00 UTC)
app.timer('dailyReviewCheck', {
    schedule: '0 0 0 * * *',
    handler: async (timer, context) => {
        try {
            const result = await checkAndPostReviews(context);
            context.log('Daily review check completed:', result);
        } catch (error) {
            context.log('Error in daily review check:', error.message);
            throw error;
        }
    }
});

// HTTP Trigger: Manually trigger review check
app.http('triggerReviewCheck', {
    methods: ['GET', 'POST'],
    authLevel: 'anonymous',
    handler: async (request, context) => {
        try {
            const result = await checkAndPostReviews(context);
            return { 
                status: 200, 
                jsonBody: result 
            };
        } catch (error) {
            context.log('Error in triggerReviewCheck:', error.message);
            return { 
                status: 500, 
                body: `Error: ${error.message}` 
            };
        }
    }
});

// HTTP Trigger: Preview reviews without posting
app.http('previewReviews', {
    methods: ['GET'],
    authLevel: 'anonymous',
    handler: async (request, context) => {
        try {
            const reviews = await checkAndPostReviews(context, { preview: true });
            return { 
                status: 200, 
                jsonBody: {
                    count: reviews.length,
                    reviews: reviews
                }
            };
        } catch (error) {
            context.log('Error in previewReviews:', error.message);
            return { 
                status: 500, 
                body: `Error: ${error.message}` 
            };
        }
    }
});

// HTTP Trigger: Test Slack connection
app.http('testSlack', {
    methods: ['GET', 'POST'],
    authLevel: 'anonymous',
    handler: async (request, context) => {
        try {
            const response = await fetch(SLACK_WEBHOOK_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    blocks: [
                        {
                            type: 'section',
                            text: {
                                type: 'mrkdwn',
                                text: '🧪 *Test Message*\nYour App Store Review Bot is connected!'
                            }
                        }
                    ]
                })
            });

            if (response.ok) {
                return { status: 200, body: 'Test message sent to Slack!' };
            } else {
                return { status: 500, body: `Slack error: ${await response.text()}` };
            }
        } catch (error) {
            return { status: 500, body: `Error: ${error.message}` };
        }
    }
});

// HTTP Trigger: Test App Store Connect API connection
app.http('testAppStore', {
    methods: ['GET'],
    authLevel: 'anonymous',
    handler: async (request, context) => {
        try {
            const token = generateToken();
            const appId = await getAppId(token, context);
            
            return { 
                status: 200, 
                jsonBody: {
                    success: true,
                    bundleId: APP_BUNDLE_ID,
                    appId: appId,
                    message: 'App Store Connect API connection successful!'
                }
            };
        } catch (error) {
            return { 
                status: 500, 
                body: `Error: ${error.message}` 
            };
        }
    }
});

// HTTP Trigger: Mark all reviews as posted (except the most recent one)
app.http('markAllPosted', {
    methods: ['POST'],
    authLevel: 'anonymous',
    handler: async (request, context) => {
        try {
            context.log('Marking all reviews as posted (except most recent)...');

            // Generate token and get app ID
            const token = generateToken();
            const appId = await getAppId(token, context);

            // Fetch reviews
            const reviews = await fetchReviews(token, appId, context);
            context.log(`Fetched ${reviews.length} reviews`);

            if (reviews.length === 0) {
                return { status: 200, jsonBody: { message: 'No reviews found', marked: 0 } };
            }

            // Sort by date (newest first) and skip the most recent one
            const sortedReviews = reviews.sort((a, b) => 
                new Date(b.attributes.createdDate) - new Date(a.attributes.createdDate)
            );
            const reviewsToMark = sortedReviews.slice(1); // Skip first (most recent)

            // Get table client
            if (!AZURE_STORAGE_ACCOUNT || !AZURE_STORAGE_KEY) {
                return { status: 500, body: 'Azure Storage not configured' };
            }

            const tableClient = getTableClient();
            await tableClient.createTable().catch(() => {});

            // Mark all as posted
            let markedCount = 0;
            for (const review of reviewsToMark) {
                await markReviewPosted(tableClient, review);
                markedCount++;
            }

            const skippedReview = sortedReviews[0];
            context.log(`Marked ${markedCount} reviews as posted, skipped most recent: ${skippedReview.id}`);

            return { 
                status: 200, 
                jsonBody: { 
                    message: `Marked ${markedCount} reviews as posted`,
                    marked: markedCount,
                    skipped: {
                        id: skippedReview.id,
                        title: skippedReview.attributes.title,
                        rating: skippedReview.attributes.rating,
                        createdDate: skippedReview.attributes.createdDate
                    }
                }
            };
        } catch (error) {
            context.log('Error in markAllPosted:', error.message);
            return { status: 500, body: `Error: ${error.message}` };
        }
    }
});
