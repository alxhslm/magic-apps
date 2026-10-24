import Foundation
@testable import MagimailHelperLib
import Testing

@Suite("MailCategory Tests")
struct MailCategoryTests {
    @Test func fallsBackToPrimaryForNilOrUnrecognized() {
        #expect(MailCategory.from(nil) == .primary)
        #expect(MailCategory.from("") == .primary)
        #expect(MailCategory.from("unknown") == .primary)
        #expect(MailCategory.from("spam") == .primary)
    }

    @Test func parsesKnownCategoriesCaseInsensitively() {
        #expect(MailCategory.from("primary") == .primary)
        #expect(MailCategory.from("PRIMARY") == .primary)
        #expect(MailCategory.from("Primary") == .primary)

        #expect(MailCategory.from("social") == .social)
        #expect(MailCategory.from("SOCIAL") == .social)

        #expect(MailCategory.from("promotions") == .promotions)
        #expect(MailCategory.from("Promotions") == .promotions)

        #expect(MailCategory.from("updates") == .updates)
        #expect(MailCategory.from("UPDATES") == .updates)

        #expect(MailCategory.from("forums") == .forums)
        #expect(MailCategory.from("Forums") == .forums)
    }

    @Test func symbolsAndTitlesMatchDesignSpec() {
        #expect(MailCategory.primary.symbolName == "tray")
        #expect(MailCategory.primary.title == "Primary")

        #expect(MailCategory.social.symbolName == "person.2")
        #expect(MailCategory.social.title == "Social")

        #expect(MailCategory.promotions.symbolName == "tag")
        #expect(MailCategory.promotions.title == "Promotions")

        #expect(MailCategory.updates.symbolName == "info.circle")
        #expect(MailCategory.updates.title == "Updates")

        #expect(MailCategory.forums.symbolName == "bubble.left.and.bubble.right")
        #expect(MailCategory.forums.title == "Forums")
    }
}
