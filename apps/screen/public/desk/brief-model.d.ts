export function optionRow(option: { label: string; description?: string }, brief: { optionKeys?: string[]; level?: number; defaultOption?: string | null }, index?: number | null): {
  key: string | null; title: string; recommended: boolean; isDefault: boolean; consequence: string; label: string;
};
