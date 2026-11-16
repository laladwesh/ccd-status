import { TEAM_URL } from '../constants';

export default function Footer() {
  return (
    <footer className="w-full h-10 sm:h-12 bg-gray-200 flex justify-around items-center mt-10">
      <a
        className="text-gray-800 text-sm sm:text-base hover:text-[#14213D]"
        href={TEAM_URL} target="_blank" rel="noopener noreferrer"
      >
        Built with heart and soul by <span className="font-medium">Team Technical Support, CCD</span>
      </a>
    </footer>
  );
}
