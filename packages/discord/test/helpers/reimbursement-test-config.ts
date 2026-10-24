import fs from "node:fs";
import path from "node:path";

/**
 * Seed a hermetic, generic reimbursement config into a profile's config dir so
 * tests do not depend on any installation-specific vendors living in the repo
 * default. Mirrors the shapes the registry relies on (a recurring vendor, a
 * merchant-named vendor, and receipt-dir vendors) with neutral names.
 */
export function writeTestReimbursementConfig(profileConfigDir: string): void {
  fs.mkdirSync(profileConfigDir, { recursive: true });
  fs.writeFileSync(
    path.join(profileConfigDir, "reimbursement-config.yaml"),
    [
      'default_system: "ExpenseDesk"',
      "categories:",
      "  reimbursable_expenses:",
      '    memo: "Reimbursable expense"',
      "    vendors: [venmo_services, meal_kit, home_service, walmart_tip]",
      "vendors:",
      "  venmo_services:",
      "    receipt_dir: Venmo",
      "    default_category: reimbursable_expenses",
      "  meal_kit:",
      '    merchant_name: "Meal Kit Co"',
      "    default_category: reimbursable_expenses",
      "  home_service:",
      '    merchant_name: "Home Service Co"',
      '    reimbursable_item: "Internet"',
      "    recurring: true",
      "    typical_amount: 100",
      "    default_category: reimbursable_expenses",
      "  walmart_tip:",
      "    receipt_dir: Walmart",
      '    reimbursable_item: "Driver tip"',
      "    default_category: reimbursable_expenses",
      "",
    ].join("\n"),
    "utf8",
  );
}
