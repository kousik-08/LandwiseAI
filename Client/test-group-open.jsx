import React, { useState } from 'react';
import { ChevronDown } from 'lucide-react';

export default function Test() {
  return (
    <details className="mt-3 group/enc border border-gray-300 p-4">
      <summary className="cursor-pointer">
        <ChevronDown className="w-3 h-3 transition-transform group-open/enc:rotate-180 inline" />
        Click to expand
      </summary>
      <div className="mt-2">
        Content here
      </div>
    </details>
  );
}
