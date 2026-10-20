import XCTest

/// First run like a new user: pick a mode, allow notifications, see the list, switch modes,
/// send a test alert. Screenshots are attached to the test result.
final class TipoffUITests: XCTestCase {
    @MainActor
    func testFirstRun() throws {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments += ["-onboarded", "NO"]
        app.launch()
        snap("1-onboarding")

        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Out & about")).firstMatch.tap()
        app.buttons["Start watching"].tap()
        let allow = XCUIApplication(bundleIdentifier: "com.apple.springboard").buttons["Allow"]
        if allow.waitForExistence(timeout: 5) { allow.tap() }

        XCTAssertTrue(app.staticTexts["Keep an eye on"].waitForExistence(timeout: 10))
        sleep(20) // load odds, backfill history, forecast
        snap("2-home-out")

        // Follow a match from the picker.
        app.buttons["pickMatches"].tap()
        let live = app.buttons["Live now"]
        if live.waitForExistence(timeout: 5) { live.tap() }   // show everything
        let star = app.collectionViews.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Follow '")).firstMatch
        XCTAssertTrue(star.waitForExistence(timeout: 10))
        star.tap()
        snap("2b-picker")
        app.buttons["Done"].firstMatch.tap()
        XCTAssertTrue(app.staticTexts["Following"].waitForExistence(timeout: 10))
        sleep(4)
        snap("2c-following")

        app.buttons["modeButton"].tap()
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "A bit of everything")).firstMatch.tap()
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
