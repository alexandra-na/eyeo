/*
 * This file is part of Adblock Plus <https://adblockplus.org/>,
 * Copyright (C) 2006-present eyeo GmbH
 *
 * Adblock Plus is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License version 3 as
 * published by the Free Software Foundation.
 *
 * Adblock Plus is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with Adblock Plus.  If not, see <http://www.gnu.org/licenses/>.
 */

"use strict";

const TEST_PAGES_URL = "https://testpages.adblockplus.org/en/";
const SKIP_ONLINE_TESTS = false;

const assert = require("assert");
const Jimp = require("jimp");
const {By, until, error: {TimeoutError}} = require("selenium-webdriver");

let lastScreenshot = Promise.resolve();

// Once we require Node.js >= 10 this should be replaced with
// the built-in finally() method of the Promise object.
function promiseFinally(p, callback)
{
  return p.then(
        callback,
        err => Promise.resolve(callback()).then(() =>
            Promise.reject(err)
        )
    );
}

function closeWindow(driver, goTo, returnTo, callback)
{
  return promiseFinally(
        driver.switchTo().window(goTo).then(() =>
            promiseFinally(
                new Promise(resolve => resolve(callback && callback())),
                () => driver.close()
            )
        ),
        () => driver.switchTo().window(returnTo)
    );
}

function takeScreenshot(element)
{
    // It would be preferable if we could use WebElement.takeScreenshot(),
    // but it's not supported on Chrome, and produces incorrect output when
    // called repeatedly, on Firefox >=58 or when using geckodriver >=1.13.
    // So as a workaround, we scroll to the position of the element, take a
    // screenshot of the viewport and crop it to the element's size and position.
  lastScreenshot = Promise.all([element.getRect(),
                                  lastScreenshot]).then(([rect]) =>
        element.getDriver().executeScript(`
      window.scrollTo(${rect.x}, ${rect.y});
      return [window.scrollX, window.scrollY];
    `).then(result =>
        {
      let x = rect.x - result[0];
            let y = rect.y - result[1];

            return element.getDriver().takeScreenshot()
                .then(s => Jimp.read(Buffer.from(s, "base64")))
                .then(img => img.crop(x, y, rect.width, rect.height).bitmap);
        })
    );
    return lastScreenshot;
}

function getSections(driver)
{
    return driver.findElements(By.css("section")).then(elements =>
        Promise.all(elements.map(e =>
            Promise.all([
                e.findElement(By.css("h2")).catch(() => null),
                e.findElement(By.className("testcase-container")).catch(() => null),
                e.findElements(By.css("pre"))
            ])
        ))
    ).then(sections => sections.filter(
        ([title, demo, filters]) => title && demo && filters.length > 0
    ));
}

it("Test pages", function()
{
    return this.driver.navigate().to(TEST_PAGES_URL).then(() =>
        this.driver.findElements(By.css(".site-pagelist a"))
    ).then(elements =>
        Promise.all(elements.map(elem => Promise.all([elem.getAttribute("class"),
            elem.getAttribute("href"),
            elem.getText()])))
    ).then(urls =>
    {
        let p1 = Promise.resolve();
        for (let [elemClass, url, pageTitle] of urls)
        {
            let onlineTestCase = elemClass &&
                elemClass.split(/\s+/).includes("online");
            if (SKIP_ONLINE_TESTS && onlineTestCase)
                continue;

            let browser = this.test.parent.title.replace(/\s.*$/, "");
            if (// https://issues.adblockplus.org/ticket/6917
                pageTitle === "$subdocument" && browser === "Firefox" ||
                // Chromium doesn't support Flash
                pageTitle.startsWith("$object") && browser === "Chromium" ||
                // Chromium 63 doesn't have user stylesheets (required to
                // overrule inline styles) and doesn't run content scripts
                // in dynamically written documents.
                this.test.parent.title === "Chromium (oldest)" &&
                (pageTitle === "Inline style !important" ||
                    pageTitle === "Anonymous iframe document.write()"))
                continue;

            p1 = p1.then(() =>
                this.driver.navigate().to(url)
            ).then(() =>
                Promise.all([
                    getSections(this.driver),
                    this.driver.executeScript(`
            let documents = [document];
            while (documents.length > 0)
            {
              let doc = documents.shift();
              doc.body.classList.add('expected');
              for (let i = 0; i < doc.defaultView.frames.length; i++)
              {
                try
                {
                  documents.push(doc.defaultView.frames[i].document);
                }
                catch (e) {}
              }
            }
          `)
                ])
            ).then(([sections]) =>
                Promise.all(sections.map(([title, demo, filters]) =>
                    Promise.all([
                        title.getAttribute("textContent").then(testTitle =>
                            `${pageTitle.trim()} - ${testTitle.trim()}`
                        ),
                        takeScreenshot(demo),
                        Promise.all(filters.map(elem => elem.getAttribute("textContent")))
                    ])
                ))
            ).then(testCases =>
            {
                let p2 = Promise.resolve();
                for (let i = 0; i < testCases.length; i++)
                {
                    let [title, expectedScreenshot, filters] = testCases[i];
                    let description = ["", "Test case: " + title, url].join("\n       ");

                    p2 = p2.then(() =>
                        this.driver.navigate().to(this.origin + "/options.html")
                    ).then(() =>
                        this.driver.executeAsyncScript(`
              let filters = arguments[0];
              let callback = arguments[arguments.length - 1];
              browser.runtime.sendMessage({type: "subscriptions.get",
                                           downloadable: true,
                                           special: true}).then(subs =>
                Promise.all(subs.map(subscription =>
                  browser.runtime.sendMessage({type: "subscriptions.remove",
                                               url: subscription.url})
                ))
              ).then(() =>
                browser.runtime.sendMessage({type: "filters.importRaw",
                                             text: filters})
              ).then(errors => callback(errors[0]), callback);
            `, filters.join("\n"))
                    ).then(error =>
                    {
                        if (error)
                            throw error;
                        return this.driver.navigate().to(url);
                    }).then(() =>
                    {
                        if (pageTitle.startsWith("$popup"))
                        {
                            return getSections(this.driver).then(sections =>
                                sections[i][1].findElement(By.css("a[href],button")).click()
                            ).then(() =>
                                this.driver.sleep(500)
                            ).then(() =>
                                this.driver.getAllWindowHandles()
                            ).then(handles =>
                            {
                                if (pageTitle === "$popup - Exception")
                                {
                                    assert(handles.length, 3,
                                        "Popup is whitelisted" + description);
                                    return closeWindow(this.driver, handles[2], handles[1]);
                                }

                                assert(handles.length, 2,
                                    "Popup is blocked" + description);
                            });
                        }

                        let checkTestCase = () =>
                            getSections(this.driver).then(sections =>
                                this.driver.wait(() =>
                                    takeScreenshot(sections[i][1]).then(screenshot =>
                                        screenshot.width === expectedScreenshot.width &&
                                        screenshot.height === expectedScreenshot.height &&
                                        screenshot.data.compare(expectedScreenshot.data) === 0
                                    ), 1000
                                ).catch(e =>
                                {
                                    if (e instanceof TimeoutError)
                                        e = new Error("Screenshots don't match" + description);
                                    throw e;
                                })
                            );

                        // Sometimes on Firefox there is a delay until the added
                        // filters become effective. So if the test case fails once,
                        // we reload the page and try once again.
                        return checkTestCase().catch(() =>
                            this.driver.navigate().refresh().then(checkTestCase)
                        );
                    });
                }
                return p2;
            });
        }
        return p1;
    });
});

it("subscribe link", function()
{
    return this.driver.navigate().to(TEST_PAGES_URL).then(() =>
        this.driver.findElement(By.id("subscribe-button")).click()
    ).then(() =>
        this.driver.wait(() =>
            this.driver.getAllWindowHandles().then(handles =>
                handles.length > 2 ? handles : null
            ), 3000
        )
    ).then(handles =>
        closeWindow(this.driver, handles[2], handles[1], () =>
            this.driver.wait(until.ableToSwitchToFrame(0), 1000).then(() =>
                this.driver.wait(
                    until.elementLocated(By.id("dialog-content-predefined")), 1000
                )
            ).then(dialog =>
                this.driver.wait(() =>
                    Promise.all([
                        dialog.isDisplayed(),
                        dialog.findElement(By.css("h3")).getText()
                    ]).then(([displayed, title]) =>
                        displayed && title === "ABP Testcase Subscription"
                    ), 1000, "dialog shown"
                ).then(() =>
                    dialog.findElement(By.css("button")).click()
                )
            ).then(() =>
                this.driver.executeAsyncScript(`
          let callback = arguments[arguments.length - 1];
          browser.runtime.sendMessage({type: "subscriptions.get",
                                       ignoreDisabled: true,
                                       downloadable: true}).then(subs =>
            subs.some(s =>
              s.url == "${TEST_PAGES_URL}abp-testcase-subscription.txt"
            )
          ).then(
            res => callback([res, null]),
            err => callback([null, err])
          );
        `)
            ).then(([added, err]) =>
            {
                if (err)
                    throw err;
                assert.ok(added, "subscription added");
            })
        )
    );
});
