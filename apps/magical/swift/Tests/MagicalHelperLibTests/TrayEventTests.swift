import Foundation
@testable import MagicalHelperLib
import Testing

@Test func focusTimeEventRendersHeadphonesGlyphAndIsNotTask() {
    let dict: [String: Any] = [
        "id": "focus_evt_1",
        "accountId": "acc_1",
        "summary": "Deep Work",
        "startTime": 1_789_027_200_000.0,
        "endTime": 1_789_030_800_000.0,
        "eventType": TrayEventKind.focusTime,
        "calendarIds": ["user@example.com"],
    ]
    let event = TrayEvent(from: dict)

    #expect(event.eventType == 7)
    #expect(event.isTask == false)
    #expect(event.kindGlyph == EventKindGlyph(symbol: "headphones", label: "Focus time"))
}

@Test func taskEventRendersCircleGlyphsAndIsTask() {
    let openDict: [String: Any] = [
        "id": "task_evt_1",
        "accountId": "acc_1",
        "summary": "Write documentation",
        "startTime": 1_789_027_200_000.0,
        "endTime": 1_789_030_800_000.0,
        "eventType": TrayEventKind.task,
        "isCompleted": false,
        "calendarIds": ["tasks@tasks.google.com"],
    ]
    let openTask = TrayEvent(from: openDict)

    #expect(openTask.eventType == 9)
    #expect(openTask.isTask == true)
    #expect(openTask.kindGlyph == EventKindGlyph(symbol: "circle", label: "Task"))

    let completedDict: [String: Any] = [
        "id": "task_evt_2",
        "accountId": "acc_1",
        "summary": "Reviewed PR",
        "startTime": 1_789_027_200_000.0,
        "endTime": 1_789_030_800_000.0,
        "eventType": TrayEventKind.task,
        "isCompleted": true,
        "calendarIds": ["tasks@tasks.google.com"],
    ]
    let completedTask = TrayEvent(from: completedDict)

    #expect(completedTask.eventType == 9)
    #expect(completedTask.isTask == true)
    #expect(completedTask.kindGlyph == EventKindGlyph(symbol: "checkmark.circle", label: "Completed task"))
}

@Test func defaultEventHasNoKindGlyphAndIsNotTask() {
    let dict: [String: Any] = [
        "id": "regular_evt_1",
        "accountId": "acc_1",
        "summary": "Team Sync",
        "startTime": 1_789_027_200_000.0,
        "endTime": 1_789_030_800_000.0,
        "eventType": 0,
        "calendarIds": ["user@example.com"],
    ]
    let event = TrayEvent(from: dict)

    #expect(event.eventType == 0)
    #expect(event.isTask == false)
    #expect(event.kindGlyph == nil)
}

@Test func locationMapsUrlHandlesEmptyAndWhitespaceLocations() {
    let base: [String: Any] = [
        "id": "loc_evt_1",
        "accountId": "acc_1",
        "summary": "Coffee",
        "startTime": 1_789_027_200_000.0,
        "endTime": 1_789_030_800_000.0,
        "calendarIds": ["user@example.com"],
    ]

    let missing = TrayEvent(from: base)
    #expect(missing.trimmedLocation == nil)
    #expect(missing.locationMapsUrl == nil)

    var emptyDict = base
    emptyDict["location"] = ""
    let empty = TrayEvent(from: emptyDict)
    #expect(empty.trimmedLocation == nil)
    #expect(empty.locationMapsUrl == nil)

    var whitespaceDict = base
    whitespaceDict["location"] = "   \n\t  "
    let whitespace = TrayEvent(from: whitespaceDict)
    #expect(whitespace.trimmedLocation == nil)
    #expect(whitespace.locationMapsUrl == nil)
}

@Test func locationMapsUrlConstructsGoogleMapsSearchUrlForAddresses() {
    let event = TrayEvent(from: [
        "id": "loc_evt_2",
        "accountId": "acc_1",
        "summary": "Lunch",
        "startTime": 1_789_027_200_000.0,
        "endTime": 1_789_030_800_000.0,
        "calendarIds": ["user@example.com"],
        "location": "  1600 Amphitheatre Parkway, Mountain View & Co  ",
    ])

    #expect(event.trimmedLocation == "1600 Amphitheatre Parkway, Mountain View & Co")
    let url = event.locationMapsUrl
    #expect(url != nil)
    #expect(url?.scheme == "https")
    #expect(url?.host == "www.google.com")
    #expect(url?.path == "/maps/search")
    #expect(url?.absoluteString.hasPrefix("https://www.google.com/maps/search/?") == true)
    let components = url.flatMap { URLComponents(url: $0, resolvingAgainstBaseURL: false) }
    let queryItems = components?.queryItems ?? []
    #expect(queryItems.contains(URLQueryItem(name: "api", value: "1")))
    #expect(queryItems.contains(URLQueryItem(name: "query", value: "1600 Amphitheatre Parkway, Mountain View & Co")))
}

@Test func locationMapsUrlOpensHttpAndHttpsUrlsDirectly() {
    let httpsEvent = TrayEvent(from: [
        "id": "loc_evt_3",
        "accountId": "acc_1",
        "summary": "Map Link",
        "startTime": 1_789_027_200_000.0,
        "endTime": 1_789_030_800_000.0,
        "calendarIds": ["user@example.com"],
        "location": " https://maps.app.goo.gl/abcdef123 ",
    ])
    #expect(httpsEvent.locationMapsUrl == URL(string: "https://maps.app.goo.gl/abcdef123"))

    let httpEvent = TrayEvent(from: [
        "id": "loc_evt_4",
        "accountId": "acc_1",
        "summary": "HTTP Link",
        "startTime": 1_789_027_200_000.0,
        "endTime": 1_789_030_800_000.0,
        "calendarIds": ["user@example.com"],
        "location": "http://example.com/office",
    ])
    #expect(httpEvent.locationMapsUrl == URL(string: "http://example.com/office"))

    let roomWithColon = TrayEvent(from: [
        "id": "loc_evt_5",
        "accountId": "acc_1",
        "summary": "Room",
        "startTime": 1_789_027_200_000.0,
        "endTime": 1_789_030_800_000.0,
        "calendarIds": ["user@example.com"],
        "location": "BuildingA:Room4",
    ])
    #expect(roomWithColon.locationMapsUrl?.host == "www.google.com")

    let uppercaseScheme = TrayEvent(from: [
        "id": "loc_evt_6",
        "accountId": "acc_1",
        "summary": "Uppercase Scheme",
        "startTime": 1_789_027_200_000.0,
        "endTime": 1_789_030_800_000.0,
        "calendarIds": ["user@example.com"],
        "location": "HTTPS://maps.example.com/place",
    ])
    #expect(uppercaseScheme.locationMapsUrl == URL(string: "HTTPS://maps.example.com/place"))

    let hostlessPath = TrayEvent(from: [
        "id": "loc_evt_7",
        "accountId": "acc_1",
        "summary": "Hostless",
        "startTime": 1_789_027_200_000.0,
        "endTime": 1_789_030_800_000.0,
        "calendarIds": ["user@example.com"],
        "location": "http:///path",
    ])
    #expect(hostlessPath.locationMapsUrl?.host == "www.google.com")
}
