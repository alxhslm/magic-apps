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
