import React from 'react';
import { createRoot } from 'react-dom/client';
import { TracePlotApp } from './TracePlotApp';
import './tracePlot.css';

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(<TracePlotApp />);
}
