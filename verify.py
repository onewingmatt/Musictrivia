from playwright.sync_api import sync_playwright
import time

def run_cuj(page):
    page.goto("http://localhost:5173")
    page.wait_for_timeout(500)

    # Register
    page.get_by_role("link", name="Sign up").click()
    page.wait_for_timeout(500)
    inputs = page.get_by_role("textbox")
    import random
    inputs.nth(0).fill(f"testuser{random.randint(0, 10000)}")
    page.locator('input[type="password"]').fill("password")
    page.get_by_role("button", name="Sign Up").click()
    page.wait_for_timeout(1500)

    # Start Quiz
    page.get_by_role("button", name="Start New Quiz").click()
    page.wait_for_timeout(1000)

    # Setup Quiz
    page.get_by_role("button", name="Let's Play!").click()
    page.wait_for_timeout(2000)

    # Answer a question
    inputs = page.get_by_role("textbox")
    inputs.nth(0).fill("never gonna give you up")
    inputs.nth(1).fill("rick astley")
    page.get_by_role("button", name="Submit Guess").click()
    page.wait_for_timeout(2000)

    page.screenshot(path="/home/jules/verification/screenshots/verification.png")
    page.wait_for_timeout(1000)

if __name__ == "__main__":
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(
            record_video_dir="/home/jules/verification/videos"
        )
        page = context.new_page()
        try:
            run_cuj(page)
        finally:
            context.close()
            browser.close()
