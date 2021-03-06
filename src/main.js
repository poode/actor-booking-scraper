const Apify = require('apify');
const { extractDetail, listPageFunction } = require('./extraction.js');
const { getAttribute, enqueueLinks, addUrlParameters, getWorkingBrowser, fixUrl, isFiltered } = require('./util.js');

/** Main function */
Apify.main(async () => {
    // Actor INPUT variable
    const input = await Apify.getValue('INPUT');

    // Actor STATE variable
    const state = await Apify.getValue('STATE') || { crawled: {} };

    // Migrating flag
    let migrating = false;
    Apify.events.on('migrating', () => { migrating = true; });

    // Check if all required input attributes are present.
    if (!input.search && !input.startUrls) {
        throw new Error('Missing "search" or "startUrls" attribute in INPUT!');
    }
    else if(input.search && input.startUrls && input.search.trim().length > 0 && input.startUrls.length > 0){
        throw new Error('It is not possible to use both "search" and "startUrls" attributes in INPUT!');
    }
    if (!(input.proxyConfig && input.proxyConfig.useApifyProxy)) {
        throw new Error('This actor cannot be used without Apify proxy.');
    }
    if (input.minScore) { input.minScore = parseFloat(input.minScore); }
    const sortBy = input.sortBy || 'bayesian_review_score';

    // Main request queue.
    const requestQueue = await Apify.openRequestQueue();

    let startUrl;
    let requestList;
    if (input.startUrls) {
        // check if attribute is an Array
        if (!Array.isArray(input.startUrls)) {
            throw new Error('INPUT.startUrls must an array!');
        }
        // convert any inconsistencies to correct format
        for (let i = 0; i < input.startUrls.length; i++) {
            let request = input.startUrls[i];
            if (typeof request === 'string') { request = { url: request }; }
            if ((!request.userData || !request.userData.label !== 'detail') && request.url.indexOf('/hotel/') > -1) {
                request.userData = { label: 'detail' };
            }
            request.url = addUrlParameters(request.url, input);
            input.startUrls[i] = request;
        }
        // create RequestList and reference startUrl
        requestList = new Apify.RequestList({ sources: input.startUrls });
        startUrl = addUrlParameters('https://www.booking.com/searchresults.html?dest_type=city;ss=paris&order=bayesian_review_score', input);
        await requestList.initialize();
    } else {
        // Create startURL based on provided INPUT.
        const dType = input.destType || 'city';
        const query = encodeURIComponent(input.search);
        startUrl = `https://www.booking.com/searchresults.html?dest_type=${dType};ss=${query}&order=${sortBy}`;
        startUrl = addUrlParameters(startUrl, input);

        // Enqueue all pagination pages.
        startUrl += '&rows=20';
        console.log(`startUrl: ${startUrl}`);
        await requestQueue.addRequest(new Apify.Request({url: startUrl, userData: {label: 'start'}}));
        if(!input.useFilters && input.maxPages){
            for(let i = 1; i <= input.maxPages; i++){
                await requestQueue.addRequest(new Apify.Request({
                    url: startUrl + '&offset=' + 20*i, 
                    userData: {label: 'page'}
                }));
            }
        }
    }

    // Temporary fix, make UI proxy input compatible
    if (input.proxyConfig && input.proxyConfig.apifyProxyGroups) {
        for (let i = 0; i < input.proxyConfig.apifyProxyGroups.length; i++) {
            const gSpl = input.proxyConfig.apifyProxyGroups[i].split('-');
            const nGroup = gSpl[gSpl.length - 1];
            input.proxyConfig.apifyProxyGroups[i] = nGroup;
        }
    }

    // Simulated browser chache
    const cache = {};

    // Main crawler variable.
    const crawler = new Apify.PuppeteerCrawler({
        requestList,

        requestQueue,

        // Browser instance creation.
        launchPuppeteerFunction: () => {
            if (!input.testProxy) {
                return Apify.launchPuppeteer(input.proxyConfig || {});
            }
            return getWorkingBrowser(startUrl, input.proxyConfig);
        },

        // Main page handling function.
        handlePageFunction: async ({ page, request, puppeteerPool }) => {
            console.log(`open url(${request.userData.label}): ${await page.url()}`);

            /** Tells the crawler to re-enqueue current page and destroy the browser.
             *  Necessary if the page was open through a not working proxy. */
            const retireBrowser = async () => {
                // console.log('proxy invalid, re-enqueuing...');
                await puppeteerPool.retire(page.browser());
                await requestQueue.addRequest(new Apify.Request({
                    url: request.url,
                    userData: request.userData,
                    uniqueKey: `${Math.random()}`,
                }));
            };

            // Check if startUrl was open correctly
            if (input.startUrls) {
                const pageUrl = await page.url();
                if (pageUrl.length < request.url.length) {
                    await retireBrowser();
                    return;
                }
            }

            if (request.userData.label === 'detail') { // Extract data from the hotel detail page
                // wait for necessary elements
                try { await page.waitForSelector('.hprt-occupancy-occupancy-info'); } catch (e) { console.log('occupancy info not found'); }

                const ldElem = await page.$('script[type="application/ld+json"]');
                const ld = JSON.parse(await getAttribute(ldElem, 'textContent'));
                await Apify.utils.puppeteer.injectJQuery(page);

                // Check if the page was open through working proxy.
                const pageUrl = await page.url();
                if (!input.startUrls && pageUrl.indexOf('label') < 0) {
                    await retireBrowser();
                    return;
                }

                // Exit if core data is not present ot the rating is too low.
                if (!ld || (ld.aggregateRating && ld.aggregateRating.ratingValue <= (input.minScore || 0))) {
                    return;
                }

                // Extract the data.
                console.log('extracting detail...');
                const detail = await extractDetail(page, ld, input);
                console.log('detail extracted');
                await Apify.pushData(detail);
            } else { // Handle hotel list page.
                // Check if the page was open through working proxy.
                const pageUrl = await page.url();
                if (!input.startUrls && pageUrl.indexOf(sortBy) < 0) {
                    await retireBrowser();
                    return;
                }

                // If it's aprropriate, enqueue all pagination pages
                const filtered = await isFiltered(page);
                if((!input.useFilters && !input.maxPages) || filtered){
                    const baseUrl = await page.url();
                    if(baseUrl.indexOf('offset') < 0){
                        console.log('enqueuing pagination pages...');
                        const countElem = await page.$('.sorth1');
                        const countData = (await getAttribute(countElem, 'textContent')).replace(/\.|,|\s/g, '').match(/\d+/);
                        if(countData){
                            const count = Math.ceil(parseInt(countData[0])/20);
                            console.log('pagination pages: ' + count);
                            for(let i = 0; i <= count; i++){
                                await requestQueue.addRequest(new Apify.Request({
                                    url: baseUrl + '&rows=20&offset=' + 20*i, 
                                    userData: {label: 'page'}
                                }));
                            }
                        }
                    }
                }
                
                // If filtering is enabled, enqueue necessary pages.
                if(input.useFilters && !filtered){
                    console.log('enqueuing filtered pages...');
                    await enqueueLinks(page, requestQueue, '.filterelement', null, 'page', fixUrl('&'), async link => {
                        const lText = await getAttribute(link, 'textContent');
                        return lText + '_' + 0;
                    });
                }

                if (input.simple) { // If simple output is enough, extract the data.
                    console.log('extracting data...');
                    await Apify.utils.puppeteer.injectJQuery(page);
                    const result = await page.evaluate(listPageFunction, input);
                    if (result.length > 0) {
                        const toBeAdded = [];
                        for (const item of result) {
                            item.url = addUrlParameters(item.url, input);
                            if (!state.crawled[item.name]) {
                                toBeAdded.push(item);
                                state.crawled[item.name] = true;
                            }
                        }
                        if (migrating) { await Apify.setValue('STATE', state); }
                        if (toBeAdded.length > 0) { await Apify.pushData(toBeAdded); }
                    }
                } else if (!input.useFilters || await isFiltered(page)) { // If not, enqueue the detail pages to be extracted.
                    console.log('enqueuing detail pages...');
                    await enqueueLinks(page, requestQueue, '.hotel_name_link', null, 'detail',
                        fixUrl('&', input), (link) => getAttribute(link, 'textContent'));
                }
            }
        },

        // Failed request handling
        handleFailedRequestFunction: async ({ request }) => {
            await Apify.pushData({
                url: request.url,
                succeeded: false,
                errors: request.errorMessages,
            });
        },

        // Function for ignoring all unnecessary requests.
        gotoFunction: async ({ page, request }) => {
            await page.setRequestInterception(true);

            page.on('request', async (nRequest) => {
                const url = nRequest.url();
                if (url.includes('.js')) nRequest.abort();
                else if (url.includes('.png')) nRequest.abort();
                else if (url.includes('.jpg')) nRequest.abort();
                else if (url.includes('.gif')) nRequest.abort();
                else if (url.includes('.css')) nRequest.abort();
                else if (url.includes('static/fonts')) nRequest.abort();
                else if (url.includes('js_tracking')) nRequest.abort();
                else if (url.includes('facebook.com')) nRequest.abort();
                else if (url.includes('googleapis.com')) nRequest.abort();
                else if (url.includes('secure.booking.com')) nRequest.abort();
                else if (url.includes('booking.com/logo')) nRequest.abort();
                else if (url.includes('booking.com/navigation_times')) nRequest.abort();
                else {
                    // Return cached response if available
                    if (cache[url] && cache[url].expires > Date.now()) {
                        await nRequest.respond(cache[url]);
                        return;
                    }
                    nRequest.continue();
                }
            });

            // Cache responses for future needs
            page.on('response', async (response) => {
                const url = response.url();
                const headers = response.headers();
                const cacheControl = headers['cache-control'] || '';
                const maxAgeMatch = cacheControl.match(/max-age=(\d+)/);
                const maxAge = maxAgeMatch && maxAgeMatch.length > 1 ? parseInt(maxAgeMatch[1], 10) : 0;
                if (maxAge && input.cacheResponses) {
                    if (!cache[url] || cache[url].expires > Date.now()) return;

                    cache[url] = {
                        status: response.status(),
                        headers: response.headers(),
                        body: response.buffer(),
                        expires: Date.now() + (maxAge * 1000),
                    };
                }
            });

            // Hide WebDriver and randomize the request.
            await Apify.utils.puppeteer.hideWebDriver(page);
            const userAgent = Apify.utils.getRandomUserAgent();
            await page.setUserAgent(userAgent);
            const cookies = await page.cookies('https://www.booking.com');
            await page.deleteCookie(...cookies);
            await page.viewport({
                width: 1024 + Math.floor(Math.random() * 100),
                height: 768 + Math.floor(Math.random() * 100)
            });
            return page.goto(request.url, { timeout: 200000 });
        },
    });

    // Start the crawler.
    await crawler.run();
});
