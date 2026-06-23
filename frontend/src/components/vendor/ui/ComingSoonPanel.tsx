import { Sparkles } from 'lucide-react';
import type { IconComponent } from '../../../types/icon';

interface ComingSoonPanelProps {
  title: string;
  description?: string;
  icon?: IconComponent;
}

const ComingSoonPanel = ({ title, description, icon: Icon = Sparkles }: ComingSoonPanelProps) => (
  <div className="flex flex-col items-center justify-center text-center py-16 px-6">
    <div className="h-14 w-14 rounded-full bg-oe-light flex items-center justify-center mb-4">
      <Icon className="h-7 w-7 text-oe-primary" />
    </div>
    <h3 className="text-lg font-medium text-gray-900 mb-1">{title}</h3>
    <p className="text-sm text-gray-500 max-w-md">
      {description ?? 'This area is coming soon. Hang tight — it’s on the roadmap.'}
    </p>
  </div>
);

export default ComingSoonPanel;
