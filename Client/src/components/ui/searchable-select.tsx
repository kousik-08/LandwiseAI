import * as React from "react";
import { Check, ChevronsUpDown } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

interface SearchableSelectProps {
  /** Selectable options. */
  options: string[];
  /** Currently selected value (controlled). */
  value: string;
  /** Called with the new value when an option (or custom text) is chosen. */
  onChange: (value: string) => void;
  /** Trigger placeholder when nothing is selected. */
  placeholder?: string;
  /** Search input placeholder. */
  searchPlaceholder?: string;
  /** Text shown when no option matches the search. */
  emptyText?: string;
  /** Allow typing a value that isn't in the options list. */
  allowCustomValue?: boolean;
  disabled?: boolean;
  className?: string;
}

/**
 * A searchable single-select combobox built on Command + Popover.
 * Displays the full option list, filters as the user types, and (optionally)
 * lets the user commit a custom value not present in the list.
 */
export function SearchableSelect({
  options,
  value,
  onChange,
  placeholder = "Select...",
  searchPlaceholder = "Search...",
  emptyText = "No results found.",
  allowCustomValue = false,
  disabled = false,
  className,
}: SearchableSelectProps) {
  const [open, setOpen] = React.useState(false);
  const [search, setSearch] = React.useState("");

  const trimmed = search.trim();
  const hasExactMatch = options.some(
    (o) => o.toLowerCase() === trimmed.toLowerCase(),
  );

  const commit = (next: string) => {
    onChange(next);
    setOpen(false);
    setSearch("");
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className={cn(
            "w-full justify-between bg-slate-50 border-slate-200 h-8 text-xs rounded-md font-normal",
            !value && "text-muted-foreground",
            className,
          )}
        >
          <span className="truncate">{value || placeholder}</span>
          <ChevronsUpDown className="ml-2 h-3.5 w-3.5 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[var(--radix-popover-trigger-width)] p-0 bg-white border-slate-200"
        align="start"
      >
        <Command shouldFilter>
          <CommandInput
            placeholder={searchPlaceholder}
            value={search}
            onValueChange={setSearch}
            className="text-xs"
          />
          <CommandList>
            <CommandEmpty>
              {allowCustomValue && trimmed ? (
                <button
                  type="button"
                  onClick={() => commit(trimmed)}
                  className="w-full px-2 py-1 text-xs text-left text-indigo-600 hover:bg-indigo-50 rounded-sm"
                >
                  Use "{trimmed}"
                </button>
              ) : (
                <span className="text-xs">{emptyText}</span>
              )}
            </CommandEmpty>
            <CommandGroup>
              {options.map((option) => (
                <CommandItem
                  key={option}
                  value={option}
                  onSelect={() => commit(option)}
                  className="text-xs"
                >
                  <Check
                    className={cn(
                      "mr-2 h-3.5 w-3.5",
                      value === option ? "opacity-100" : "opacity-0",
                    )}
                  />
                  {option}
                </CommandItem>
              ))}
              {allowCustomValue && trimmed && !hasExactMatch && (
                <CommandItem
                  value={`__custom__${trimmed}`}
                  onSelect={() => commit(trimmed)}
                  className="text-xs text-indigo-600"
                >
                  <Check className="mr-2 h-3.5 w-3.5 opacity-0" />
                  Use "{trimmed}"
                </CommandItem>
              )}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
