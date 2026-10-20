import XCTest

/// First run like a new user: pick a mode, allow notifications, see the list, switch modes,
/// send a test alert. Screenshots are attached to the test result.
final class OddshotUITests: XCTestCase {
    @MainActor
    func testFirstRun() throws {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments += ["-onboarded", "NO"]
        app.launch()
        snap("1-onboarding")

        app.staticTexts["Out & about"].tap()
        app.buttons["Start watching"].tap()
        let allow = XCUIApplication(bundleIdentifier: "com.apple.springboard").buttons["Allow"]
        if allow.waitForExistence(timeout: 5) { allow.tap() }

        XCTAssertTrue(app.staticTexts["Keep an eye on"].waitForExistence(timeout: 10))
        sleep(20) // load odds, backfill history, forecast
        snap("2-home-out")

        app.buttons["modeButton"].tap()
        app.staticTexts["A bit of everything"].tap()
        sleep(15)
        snap("3-home-everything")

        app.buttons["settingsButton"].tap()
        app.buttons["Send a test alert"].tap()
        sleep(2)
        snap("4-test-alert")
    }

    @MainActor
    private func snap(_ name: String) {
        let a = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        a.name = name
        a.lifetime = .keepAlways
        add(a)
    }
}
