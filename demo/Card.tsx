export function Card({ title }: { title: string }) {
  return (
    <div className="bg-white p-6">
      <h2 className="text-gray-400 text-2xl font-bold">{title}</h2>
      <p className="text-gray-400">Supporting copy that is hard to read.</p>
      <span className="text-emerald-500">Status: active</span>
      <p className="text-gray-700">This passes and must be left alone.</p>
    </div>
  );
}
