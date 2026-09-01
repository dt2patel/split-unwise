import XCTest

final class NavigationGestureTests: XCTestCase {
    private let bundleIdentifier = "app.splitunwise.mobile"

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testCancelledAndCompletedEdgeSwipesKeepAVisiblePage() throws {
        let app = XCUIApplication(bundleIdentifier: bundleIdentifier)
        if app.state == .notRunning {
            app.launch()
        } else {
            app.activate()
        }

        let homeHeading = app.staticTexts["Home"]
        XCTAssertTrue(homeHeading.waitForExistence(timeout: 60), "The native app did not reach Home.")

        let groupName = "Lake House Weekend"
        let groupLink = app.staticTexts[groupName].firstMatch
        XCTAssertTrue(groupLink.waitForExistence(timeout: 30), "The gesture-test group was not visible.")
        groupLink.tap()

        let inviteButton = app.staticTexts["Invite"].firstMatch
        XCTAssertTrue(inviteButton.waitForExistence(timeout: 30), "The native group page did not load its Invite action.")

        for attempt in 1...5 {
            inviteButton.tap()
            let inviteHeading = app.staticTexts["Invite to \(groupName)"]
            XCTAssertTrue(inviteHeading.waitForExistence(timeout: 15), "Invite did not open on attempt \(attempt).")

            cancelledEdgeSwipe(in: app)
            XCTAssertTrue(inviteHeading.waitForExistence(timeout: 5), "Cancelled swipe \(attempt) left the native outlet blank.")

            completedEdgeSwipe(in: app)
            XCTAssertTrue(inviteButton.waitForExistence(timeout: 10), "Completed swipe \(attempt) did not restore the group page.")
        }
    }

    private func cancelledEdgeSwipe(in app: XCUIApplication) {
        let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.01, dy: 0.52))
        let finish = app.coordinate(withNormalizedOffset: CGVector(dx: 0.13, dy: 0.52))
        start.press(forDuration: 0.2, thenDragTo: finish, withVelocity: .slow, thenHoldForDuration: 0.2)
    }

    private func completedEdgeSwipe(in app: XCUIApplication) {
        let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.01, dy: 0.52))
        let finish = app.coordinate(withNormalizedOffset: CGVector(dx: 0.92, dy: 0.52))
        start.press(forDuration: 0.1, thenDragTo: finish, withVelocity: .fast, thenHoldForDuration: 0)
    }
}
