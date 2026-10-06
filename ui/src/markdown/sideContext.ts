import { createContext } from 'react';
import type { MarkdownContext } from './types';

/** 5C: inside a removed part of a rendered diff, the context links, images and references resolve
 * against: the old side's commit and path (R7, R9). `null` everywhere else. */
export const MdContextOverride = createContext<MarkdownContext | null>(null);
